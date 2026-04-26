const WebSocket = require('ws');
const { app, BrowserWindow, ipcMain } = require('electron');
const { exec, execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// UAC PROMPT (For smooth Git Bash & EXE execution)
function isRunAsAdmin() {
    try {
        execSync('net session', { stdio: 'ignore', windowsHide: true });
        return true;
    } catch (e) {
        return false;
    }
}

app.whenReady().then(() => {
    if (!isRunAsAdmin()) {
        console.log("🔒 Requesting Admin Permission...");
        const ps1Path = path.join(os.tmpdir(), 'vpn_elevate.ps1');
        const exePath = process.execPath;
        const appDir = __dirname;
        
        let scriptContent = app.isPackaged 
            ? `Start-Process -FilePath '${exePath}' -Verb RunAs -Wait`
            : `Start-Process -FilePath '${exePath}' -ArgumentList '"${appDir}"' -Verb RunAs -Wait`;
        
        fs.writeFileSync(ps1Path, scriptContent);
        const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path], { stdio: 'inherit' });
        
        child.on('exit', (code) => {
            app.quit();
            process.exit(code || 0);
        });
    } else {
        runAdminApp();
    }
});

function runAdminApp() {
    const getScriptPath = (filename) => path.join(app.getPath('userData'), filename);
    
    let torDir = "";
    function setupWritableTor() {
        const userDataPath = app.getPath('userData');
        const localTorPath = path.join(userDataPath, 'Tor');
        const originalTorPath = app.isPackaged
            ? path.join(process.resourcesPath, 'app.asar.unpacked', 'Tor')
            : path.join(__dirname, 'Tor');

        try {
            if (!fs.existsSync(localTorPath)) {
                fs.cpSync(originalTorPath, localTorPath, { recursive: true });
            }
        } catch (err) {}
        torDir = path.join(localTorPath, 'tor');
    }

    function createWindow () {
        const win = new BrowserWindow({
            width: 1000, height: 670, resizable: false, autoHideMenuBar: true,
            icon: path.join(__dirname, 'icon.png'),
            webPreferences: { nodeIntegration: true, contextIsolation: false }
        });
        win.loadFile('index.html');
    }

    // 🌐 WebSocket Server Setup
    const wss = new WebSocket.Server({ port: 8080 });
    let appState = {
        connected: false,
        serverCode: 'us',
        killSwitch: false,
        bypassList: '',
        servers: {}
    };

    function broadcastState() {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: "STATE_SYNC", state: appState }));
            }
        });
    }

    wss.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: "STATE_SYNC", state: appState }));

        ws.on('message', async (message) => {
            const data = JSON.parse(message);
            if (data.command === "PING") return;

            const webContents = BrowserWindow.getAllWindows()[0].webContents;

            if (data.command === "CONNECT") webContents.send('force-connect-ui');
            else if (data.command === "DISCONNECT") webContents.send('force-disconnect-ui');
            else if (data.command === "CHANGE_SERVER") {
                appState.serverCode = data.server;
                webContents.send('sync-ui-state', appState);
                broadcastState();
            }
            else if (data.command === "TOGGLE_KS") {
                appState.killSwitch = data.enabled;
                webContents.send('sync-ui-state', appState);
                broadcastState();
            }
            else if (data.command === "UPDATE_BYPASS") {
                appState.bypassList = data.list;
                webContents.send('sync-ui-state', appState);
                broadcastState();
            }
        });
    });

    try { execSync(`taskkill /F /IM tor.exe`, { stdio: 'ignore' }); } catch(e){}
    setupWritableTor();
    createWindow();

    app.on('window-all-closed', () => {
        try {
            const helperBatPath = getScriptPath('fp_exit.bat');
            const batContent = `@echo off\nreg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f\npowershell -Command "Get-NetAdapter | Set-DnsClientServerAddress -ResetServerAddresses"`;
            fs.writeFileSync(helperBatPath, batContent);
            exec(`"${helperBatPath}"`, { windowsHide: true });
            exec(`taskkill /F /IM tor.exe`, { windowsHide: true });
        } catch(e) {}
        if (process.platform !== 'darwin') app.quit();
    });

    ipcMain.handle('get-fastest-server', async () => {
        return { best: "sg", others: ["hk", "jp"] };
    });

    let cachedRelays = null;
    let lastFetchTime = 0;

    ipcMain.handle('get-realtime-status', async () => {
        const now = Date.now();
        if (cachedRelays && (now - lastFetchTime < 20000)) return cachedRelays;

        const fetchAPI = async (url, timeoutMs) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                const response = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (!response.ok) return null;
                const data = await response.json();
                return data.relays ? data.relays : null;
            } catch (e) { return null; }
        };

        const targetUrl = 'https://onionoo.torproject.org/details?type=relay&running=true&fields=country';
        let relays = await fetchAPI(targetUrl, 3500);
        if (!relays) relays = await fetchAPI('https://api.allorigins.win/raw?url=' + encodeURIComponent(targetUrl), 3500);

        if (relays) {
            const counts = {};
            relays.forEach(r => { if (r.country) counts[r.country.toLowerCase()] = (counts[r.country.toLowerCase()] || 0) + 1; });
            if (Object.keys(counts).length > 0) {
                cachedRelays = counts;
                appState.servers = cachedRelays;
                broadcastState();
                lastFetchTime = Date.now();
                return counts;
            }
        }
        
        if (cachedRelays) return cachedRelays;
        return {
            "us": 1200, "de": 900, "fr": 600, "nl": 500, "gb": 400, "ca": 250, "sg": 150, "jp": 120,
            "au": 80, "ch": 100, "se": 90, "fi": 80, "pl": 70, "at": 60, "es": 50, "it": 40, "ro": 30,
            "cz": 25, "no": 20, "dk": 20, "be": 15, "ie": 15, "in": 5, "bd": 1
        };
    });

    // 🚀 VPN Connect Handler
    ipcMain.handle('connect-vpn', async (event, data) => {
        return new Promise((resolve) => {
            const { serverCode, bypassList } = data;
            const port = 9050; 

            let formattedBypass = "<local>";
            if (bypassList && bypassList.trim() !== '') {
                const list = bypassList.split(';').map(s => s.trim().replace(/\*/g, '') ? `*${s.trim().replace(/\*/g, '')}*` : '').filter(s => s !== '').join(';');
                formattedBypass = list ? list + ';<local>' : "<local>";
            }

            try { execSync(`taskkill /F /IM tor.exe`, { stdio: 'ignore' }); } catch(e){}

            const batPath = path.join(torDir, 'start-vpn.bat');
            exec(`"${batPath}" ${serverCode} ${port}`, { cwd: torDir, windowsHide: true });

            // ৩ সেকেন্ড ওয়েট করে প্রক্সি সেট করে সাকসেস রিটার্ন করবে এবং এক্সটেনশনকে জানাবে
            setTimeout(() => {
                const helperBatPath = getScriptPath('fp_conn.bat');
                const batContent = `@echo off\nreg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "socks=127.0.0.1:${port}" /f\nreg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f\nreg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "${formattedBypass}" /f\npowershell -Command "Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | Set-DnsClientServerAddress -ServerAddresses '127.0.0.1'"`;
                fs.writeFileSync(helperBatPath, batContent);
                exec(`"${helperBatPath}"`, { windowsHide: true });
                
                appState.connected = true;
                broadcastState();
                resolve({ status: "connected" }); // UI আপডেট
            }, 3000); 
        });
    });

    // 🛑 VPN Disconnect Handler
    ipcMain.handle('disconnect-vpn', async (event, isKillSwitchOn) => {
        return new Promise((resolve) => {
            const helperBatPath = getScriptPath('fp_disconn.bat');
            let batContent = isKillSwitchOn 
                ? `@echo off\nreg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "socks=127.0.0.1:9999" /f\nreg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f\npowershell -Command "Get-NetAdapter | Set-DnsClientServerAddress -ResetServerAddresses"`
                : `@echo off\nreg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f\npowershell -Command "Get-NetAdapter | Set-DnsClientServerAddress -ResetServerAddresses"`;

            fs.writeFileSync(helperBatPath, batContent);
            exec(`"${helperBatPath}"`, { windowsHide: true });
            
            exec(`taskkill /F /IM tor.exe`, { windowsHide: true }, () => {
                appState.connected = false;
                broadcastState();
                resolve({ status: "disconnected" }); // UI আপডেট
            });
        });
    });

    ipcMain.handle('toggle-killswitch', async (event, isEnabled) => {
        appState.killSwitch = isEnabled; 
        broadcastState(); // এক্সটেনশন আপডেট হবে

        const helperBatPath = getScriptPath('fp_ks.bat');
        let batContent = isEnabled 
            ? `@echo off\nreg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "socks=127.0.0.1:9999" /f\nreg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f\npowershell -Command "Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | Set-DnsClientServerAddress -ResetServerAddresses"`
            : `@echo off\nreg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f\npowershell -Command "Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | Set-DnsClientServerAddress -ResetServerAddresses"`;
        fs.writeFileSync(helperBatPath, batContent);
        exec(`"${helperBatPath}"`, { windowsHide: true });
        return { status: "done" };
    });

    ipcMain.handle('update-live-bypass', async (event, bypassList) => {
        return new Promise((resolve) => {
            appState.bypassList = bypassList; 
            broadcastState(); // এক্সটেনশন আপডেট হবে

            let formattedBypass = "<local>";
            if (bypassList && bypassList.trim() !== '') {
                const list = bypassList.replace(/,/g, ';').split(';').map(s => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[\*\s]/g, '') ? `*${s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[\*\s]/g, '')}*` : '').filter(s => s !== '').join(';');
                formattedBypass = list ? list + ';<local>' : "<local>";
            }
            const helperBatPath = getScriptPath('fp_bypass.bat');
            const batContent = `@echo off\nreg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "${formattedBypass}" /f\npowershell -Command "Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | Set-DnsClientServerAddress -ServerAddresses '127.0.0.1'"`;
            fs.writeFileSync(helperBatPath, batContent);
            exec(`"${helperBatPath}"`, { windowsHide: true });
            resolve({ status: "updated" });
        });
    });
}