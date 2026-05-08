const WebSocket = require('ws');
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const { exec, execSync, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ════════════════════════════════════════════════════════════
//  LOGGER  (ASCII-only output — no Unicode, no garbled chars)
//
//  Fix: Windows terminal (CP1252) garbles UTF-8 characters
//  like === and —. Replaced with plain ASCII equivalents.
// ════════════════════════════════════════════════════════════
const Logger = (() => {
    let logDir = '', logFile = '';

    function init(ud) {
        logDir = path.join(ud, 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        rotateLogs();
        logFile = path.join(logDir, `freeproxy-${dateStr()}.log`);
        write('INFO', '======================================');
        write('INFO', `FreeProxy VPN started -- PID ${process.pid}`);
        write('INFO', `Platform: ${os.type()} ${os.release()} | Arch: ${os.arch()}`);
        write('INFO', `Electron: ${process.versions.electron}  Node: ${process.versions.node}`);
        write('INFO', '======================================');
    }

    function dateStr() { return new Date().toISOString().slice(0, 10); }
    function timeStr() { return new Date().toISOString().replace('T', ' ').slice(0, 23); }

    function rotateLogs() {
        try {
            const files = fs.readdirSync(logDir)
                .filter(f => f.startsWith('freeproxy-') && f.endsWith('.log')).sort();
            while (files.length > 7) fs.unlinkSync(path.join(logDir, files.shift()));
        } catch(e) {}
    }

    function write(level, message, meta = null) {
        const ts   = timeStr();
        const pad  = level.padEnd(7);
        const ms   = meta ? '  ' + JSON.stringify(meta) : '';
        const line = `[${ts}] [${pad}] ${message}${ms}\n`;
        // ASCII colour codes (safe on all Windows terminals)
        const colours = {
            DEBUG: '\x1b[90m', INFO: '\x1b[37m',
            WARN:  '\x1b[33m', ERROR: '\x1b[31m', SUCCESS: '\x1b[32m'
        };
        process.stdout.write((colours[level] || '') + line + '\x1b[0m');
        if (logFile) { try { fs.appendFileSync(logFile, line); } catch(e) {} }
        const nf = path.join(logDir, `freeproxy-${dateStr()}.log`);
        if (nf !== logFile) logFile = nf;
    }

    function tail(n = 300, level = 'ALL') {
        try {
            const content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
            let lines = content.split('\n').filter(Boolean);
            if (level !== 'ALL') lines = lines.filter(l => l.includes(`[${level}`));
            return lines.slice(-n);
        } catch(e) { return []; }
    }

    return {
        init,
        getLogFile: () => logFile,
        getLogDir:  () => logDir,
        tail,
        debug:   (m, x) => write('DEBUG',   m, x),
        info:    (m, x) => write('INFO',    m, x),
        warn:    (m, x) => write('WARN',    m, x),
        error:   (m, x) => write('ERROR',   m, x),
        success: (m, x) => write('SUCCESS', m, x),
    };
})();

// ════════════════════════════════════════════════════════════
//  GEOLOCATION COORDS  (capital cities per country)
// ════════════════════════════════════════════════════════════
const GEO_COORDS = {
    'us':{ lat:38.8951,  lng:-77.0364,  accuracy:15, city:'Washington D.C.'   },
    'gb':{ lat:51.5074,  lng:-0.1278,   accuracy:12, city:'London'            },
    'ca':{ lat:45.4215,  lng:-75.6919,  accuracy:14, city:'Ottawa'            },
    'au':{ lat:-35.2809, lng:149.1300,  accuracy:16, city:'Canberra'          },
    'de':{ lat:52.5200,  lng:13.4050,   accuracy:10, city:'Berlin'            },
    'fr':{ lat:48.8566,  lng:2.3522,    accuracy:11, city:'Paris'             },
    'nl':{ lat:52.3676,  lng:4.9041,    accuracy:10, city:'Amsterdam'         },
    'it':{ lat:41.9028,  lng:12.4964,   accuracy:13, city:'Rome'              },
    'es':{ lat:40.4168,  lng:-3.7038,   accuracy:12, city:'Madrid'            },
    'ch':{ lat:46.9481,  lng:7.4474,    accuracy:10, city:'Bern'              },
    'se':{ lat:59.3293,  lng:18.0686,   accuracy:12, city:'Stockholm'         },
    'no':{ lat:59.9139,  lng:10.7522,   accuracy:11, city:'Oslo'              },
    'dk':{ lat:55.6761,  lng:12.5683,   accuracy:10, city:'Copenhagen'        },
    'fi':{ lat:60.1699,  lng:24.9384,   accuracy:13, city:'Helsinki'          },
    'pl':{ lat:52.2297,  lng:21.0122,   accuracy:14, city:'Warsaw'            },
    'ro':{ lat:44.4268,  lng:26.1025,   accuracy:15, city:'Bucharest'         },
    'at':{ lat:48.2082,  lng:16.3738,   accuracy:11, city:'Vienna'            },
    'be':{ lat:50.8503,  lng:4.3517,    accuracy:10, city:'Brussels'          },
    'cz':{ lat:50.0755,  lng:14.4378,   accuracy:12, city:'Prague'            },
    'hu':{ lat:47.4979,  lng:19.0402,   accuracy:13, city:'Budapest'          },
    'pt':{ lat:38.7169,  lng:-9.1399,   accuracy:12, city:'Lisbon'            },
    'gr':{ lat:37.9838,  lng:23.7275,   accuracy:14, city:'Athens'            },
    'ie':{ lat:53.3498,  lng:-6.2603,   accuracy:11, city:'Dublin'            },
    'lu':{ lat:49.6117,  lng:6.1319,    accuracy:10, city:'Luxembourg City'   },
    'ru':{ lat:55.7558,  lng:37.6173,   accuracy:20, city:'Moscow'            },
    'ua':{ lat:50.4501,  lng:30.5234,   accuracy:18, city:'Kyiv'              },
    'jp':{ lat:35.6762,  lng:139.6503,  accuracy:12, city:'Tokyo'             },
    'kr':{ lat:37.5665,  lng:126.9780,  accuracy:11, city:'Seoul'             },
    'cn':{ lat:39.9042,  lng:116.4074,  accuracy:25, city:'Beijing'           },
    'sg':{ lat:1.3521,   lng:103.8198,  accuracy:10, city:'Singapore'         },
    'in':{ lat:28.6139,  lng:77.2090,   accuracy:22, city:'New Delhi'         },
    'bd':{ lat:23.8103,  lng:90.4125,   accuracy:18, city:'Dhaka'             },
    'pk':{ lat:33.7294,  lng:73.0931,   accuracy:20, city:'Islamabad'         },
    'ae':{ lat:24.4539,  lng:54.3773,   accuracy:12, city:'Abu Dhabi'         },
    'sa':{ lat:24.6877,  lng:46.7219,   accuracy:14, city:'Riyadh'            },
    'qa':{ lat:25.2854,  lng:51.5310,   accuracy:11, city:'Doha'              },
    'kw':{ lat:29.3759,  lng:47.9774,   accuracy:12, city:'Kuwait City'       },
    'om':{ lat:23.5880,  lng:58.3829,   accuracy:13, city:'Muscat'            },
    'il':{ lat:31.7683,  lng:35.2137,   accuracy:12, city:'Jerusalem'         },
    'tr':{ lat:39.9334,  lng:32.8597,   accuracy:15, city:'Ankara'            },
    'id':{ lat:-6.2088,  lng:106.8456,  accuracy:18, city:'Jakarta'           },
    'my':{ lat:3.1390,   lng:101.6869,  accuracy:13, city:'Kuala Lumpur'      },
    'th':{ lat:13.7563,  lng:100.5018,  accuracy:14, city:'Bangkok'           },
    'vn':{ lat:21.0285,  lng:105.8542,  accuracy:16, city:'Hanoi'             },
    'ph':{ lat:14.5995,  lng:120.9842,  accuracy:15, city:'Manila'            },
    'hk':{ lat:22.3193,  lng:114.1694,  accuracy:11, city:'Hong Kong'         },
    'tw':{ lat:25.0330,  lng:121.5654,  accuracy:12, city:'Taipei'            },
    'za':{ lat:-25.7479, lng:28.2293,   accuracy:18, city:'Pretoria'          },
    'eg':{ lat:30.0444,  lng:31.2357,   accuracy:16, city:'Cairo'             },
    'ng':{ lat:9.0579,   lng:7.4951,    accuracy:22, city:'Abuja'             },
    'ke':{ lat:-1.2921,  lng:36.8219,   accuracy:17, city:'Nairobi'           },
    'ma':{ lat:33.9716,  lng:-6.8498,   accuracy:15, city:'Rabat'             },
    'br':{ lat:-15.7801, lng:-47.9292,  accuracy:20, city:'Brasilia'          },
    'ar':{ lat:-34.6037, lng:-58.3816,  accuracy:16, city:'Buenos Aires'      },
    'mx':{ lat:19.4326,  lng:-99.1332,  accuracy:18, city:'Mexico City'       },
    'co':{ lat:4.7110,   lng:-74.0721,  accuracy:17, city:'Bogota'            },
    'cl':{ lat:-33.4489, lng:-70.6693,  accuracy:14, city:'Santiago'          },
    'nz':{ lat:-41.2865, lng:174.7762,  accuracy:13, city:'Wellington'        },
    'is':{ lat:64.1355,  lng:-21.8954,  accuracy:12, city:'Reykjavik'         },
    'kz':{ lat:51.1801,  lng:71.4460,   accuracy:22, city:'Nur-Sultan'        },
};

// ════════════════════════════════════════════════════════════
//  GEOLOCATION SPOOF ENGINE
// ════════════════════════════════════════════════════════════
let geoSpoofActive = false;

function applyGeolocationSpoof(win, serverCode) {
    const coord = GEO_COORDS[serverCode.toLowerCase()];
    if (!coord) { Logger.warn('No geo coords for code', { serverCode }); return; }

    const jitter = () => (Math.random() - 0.5) * 0.004;
    const lat = coord.lat + jitter();
    const lng = coord.lng + jitter();

    // ── Layer 1: CDP override (Electron window) ─────────────────
    try {
        if (!win.webContents.debugger.isAttached()) {
            win.webContents.debugger.attach('1.3');
        }
        win.webContents.debugger.sendCommand('Emulation.setGeolocationOverride', {
            latitude:  lat,
            longitude: lng,
            accuracy:  coord.accuracy,
        }).then(() => {
            Logger.success(`GPS spoofed -> ${coord.city} (${serverCode.toUpperCase()})`);
            geoSpoofActive = true;
        }).catch(e => Logger.error('CDP geo override failed', { err: e.message }));
    } catch(e) {
        Logger.error('CDP debugger attach failed', { err: e.message });
    }

    // ── Layer 2: Notify renderer to patch navigator.geolocation ─
    win.webContents.send('geo-spoof-on', {
        lat, lng, accuracy: coord.accuracy, city: coord.city, country: serverCode.toUpperCase(),
    });

    // ── Layer 3: Windows Location Service registry override ──────
    // Writes fake location to the Windows sensor simulator.
    // Chrome/Edge on Windows reads from Google Location Services
    // which is IP-based — so the exit IP country is the real fix.
    // But this registry key acts as an additional layer for apps
    // that read Windows Location directly.
    try {
        const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Location';
        execSync(`reg add "${regKey}" /v "OverrideLatitude" /t REG_SZ /d "${lat.toFixed(6)}" /f`, { windowsHide: true });
        execSync(`reg add "${regKey}" /v "OverrideLongitude" /t REG_SZ /d "${lng.toFixed(6)}" /f`, { windowsHide: true });
        Logger.debug('Windows Location registry override set');
    } catch(e) { Logger.debug('Windows Location registry: ' + e.message); }
}

function clearGeolocationSpoof(win) {
    if (!geoSpoofActive) return;
    try {
        if (win.webContents.debugger.isAttached()) {
            win.webContents.debugger.sendCommand('Emulation.clearGeolocationOverride')
                .catch(e => Logger.warn('CDP geo clear failed', { err: e.message }));
        }
    } catch(e) {}
    win.webContents.send('geo-spoof-off');
    // Clear Windows Location registry override
    try {
        const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Location';
        execSync(`reg delete "${regKey}" /v "OverrideLatitude" /f 2>nul`, { windowsHide: true });
        execSync(`reg delete "${regKey}" /v "OverrideLongitude" /f 2>nul`, { windowsHide: true });
    } catch(e) {}
    geoSpoofActive = false;
    Logger.info('GPS spoof cleared -- real location restored');
}

// ════════════════════════════════════════════════════════════
//  UAC CHECK
// ════════════════════════════════════════════════════════════
function isRunAsAdmin() {
    try { execSync('net session', { stdio: 'ignore', windowsHide: true }); return true; }
    catch(e) { return false; }
}

// Override userData to C:\ProgramData\freeproxy-vpn (no spaces in path)
// Must be set BEFORE app.getPath() is ever called
const APPDATA_PATH = 'C:\\ProgramData\\freeproxy-vpn';
try {
    if (!require('fs').existsSync(APPDATA_PATH)) {
        require('fs').mkdirSync(APPDATA_PATH, { recursive: true });
    }
    app.setPath('userData', APPDATA_PATH);
} catch(e) { /* fallback to default if setPath fails */ }

app.whenReady().then(() => {
    Logger.init(app.getPath('userData'));
    Logger.info('app.whenReady() fired');

    if (!isRunAsAdmin()) {
        Logger.warn('Not admin -- requesting elevation');
        const ps1 = path.join(os.tmpdir(), 'vpn_elevate.ps1');
        const exe = process.execPath, dir = __dirname;
        const scr = app.isPackaged
            ? `Start-Process -FilePath '${exe}' -Verb RunAs -Wait`
            : `Start-Process -FilePath '${exe}' -ArgumentList '"${dir}"' -Verb RunAs -Wait`;
        fs.writeFileSync(ps1, scr);
        const child = spawn('powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
            { stdio: 'inherit' });
        child.on('exit', code => {
            Logger.info(`Elevation exited: ${code}`);
            app.quit(); process.exit(code || 0);
        });
    } else {
        Logger.success('Running with admin privileges');
        runAdminApp();
    }
});

// ════════════════════════════════════════════════════════════
//  MAIN APP
// ════════════════════════════════════════════════════════════
function runAdminApp() {
    const getScriptPath = f => path.join(app.getPath('userData'), f);
    let torDir = '';
    let mainWindow = null;

    function runBat(filePath, content) {
        // ─────────────────────────────────────────────────────
        //  ROOT CAUSE FIX: exec() path-with-spaces bug
        //
        //  exec(`"C:\Users\User pc\...\file.bat"`) runs:
        //    cmd.exe /c "C:\Users\User pc\...\file.bat"
        //  cmd.exe strips outer quotes → tries to run the bare
        //  path → space splits it → bat never executes → proxy
        //  never set → no internet.
        //
        //  spawn(['cmd.exe', '/c', filePath]) passes filePath as
        //  a separate OS argument → Windows handles spaces → works.
        // ─────────────────────────────────────────────────────
        return new Promise(resolve => {
            fs.writeFileSync(filePath, content, 'utf8');
            const proc = spawn('cmd.exe', ['/c', filePath], {
                windowsHide: true,
                stdio: 'pipe'
            });
            proc.on('exit', (code) => {
                if (code !== 0) Logger.warn(`bat exit code ${code}`, { filePath });
                else Logger.debug(`bat OK`, { filePath });
                resolve();
            });
            proc.on('error', (err) => {
                Logger.error(`bat spawn error`, { filePath, err: err.message });
                resolve(); // always resolve so Promise chain continues
            });
        });
    }

    function setupWritableTor() {
        const ud  = app.getPath('userData');
        const dst = path.join(ud, 'Tor');
        const src = app.isPackaged
            ? path.join(process.resourcesPath, 'app.asar.unpacked', 'Tor')
            : path.join(__dirname, 'Tor');
        try {
            if (!fs.existsSync(dst)) {
                Logger.info('Copying Tor bundle...');
                fs.cpSync(src, dst, { recursive: true });
                Logger.success('Tor bundle ready');
            } else {
                Logger.debug('Tor bundle already present');
            }
        } catch(e) { Logger.error('Tor bundle copy failed', { err: e.message }); }
        torDir = path.join(dst, 'tor');
    }

    // ── Startup cleanup ───────────────────────────────────
    function startupCleanup() {
        Logger.info('Startup cleanup...');
        try { execSync('taskkill /F /IM tor.exe', { stdio: 'ignore', windowsHide: true }); Logger.debug('Killed stale tor.exe'); } catch(e) {}

        const bat = getScriptPath('fp_startup_clean.bat');
        const content = [
            '@echo off',
            // Remove proxy
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "" /f`,
            // Restore DNS: remove portproxy + clear global NameServer
            `netsh interface portproxy delete v4tov4 listenport=53 listenaddress=127.0.0.1 2>nul`,
            `reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters" /v "NameServer" /f 2>nul`,
            `ipconfig /flushdns`,
            // Restore IPv6
            `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters" /v DisabledComponents /t REG_DWORD /d 0 /f`,
            `powershell -Command "Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | ForEach-Object { try { Enable-NetAdapterBinding -Name $_.Name -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue } catch {} }"`,
            `netsh interface teredo set state default`,
            `netsh interface isatap set state default`,
            `netsh interface 6to4 set state default`,
            `ipconfig /flushdns`,
        ].join('\r\n');

        try {
            fs.writeFileSync(bat, content, 'utf8');
            // Use cmd.exe with separate arg to handle spaces in path
            execSync(`cmd.exe /c "${bat}"`, { windowsHide: true, timeout: 15000 });
            Logger.success('Startup cleanup complete');
        } catch(e) { Logger.error('Startup cleanup failed', { err: e.message }); }
    }

    // ── First-run verification ────────────────────────────
    function firstRunCheck() {
        const torExePath = path.join(torDir, 'tor.exe');
        if (!fs.existsSync(torExePath)) {
            Logger.warn('First-run: tor.exe not found', { path: torExePath });
        } else {
            Logger.success('First-run: tor.exe found');
        }

        // Self-heal firewall rule
        try {
            const fwOut = execSync(
                'netsh advfirewall firewall show rule name="FreeProxy Tor Engine"',
                { windowsHide: true, encoding: 'utf8' }
            );
            if (fwOut.includes('FreeProxy Tor Engine')) {
                Logger.debug('Firewall rule present');
            } else {
                throw new Error('not found');
            }
        } catch(e) {
            Logger.warn('Firewall rule missing -- adding automatically');
            const torExePath = path.join(torDir, 'tor.exe');
            try {
                execSync(
                    `netsh advfirewall firewall add rule name="FreeProxy Tor Engine" dir=out action=allow program="${torExePath}" enable=yes profile=any`,
                    { windowsHide: true }
                );
                Logger.success('Firewall rule added');
            } catch(e2) { Logger.warn('Could not add firewall rule (dev mode ok)', { err: e2.message }); }
        }
    }

    // ── Proxy bat builder ─────────────────────────────────
    function buildProxyBat(port, bypassList) {
        let fp = '<local>';
        if (bypassList && bypassList.trim()) {
            const parts = bypassList.split(';')
                .map(s => { const c = s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[\*\s]/g, ''); return c ? `*${c}*` : ''; })
                .filter(Boolean);
            if (parts.length) fp = parts.join(';') + ';<local>';
        }
        return [
            '@echo off',
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "socks=127.0.0.1:${port}" /f`,
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`,
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "${fp}" /f`,
        ].join('\r\n');
    }

    // ════════════════════════════════════════════════════════
    //  LEAK PROTECTION
    //
    //  DNS fix:
    //    ROOT CAUSE: DNSPort 53 conflicts with Windows dnscache
    //    service on port 53 -- tor.exe fails to bind, can't
    //    resolve guard node addresses, bootstrap stays at 0%.
    //
    //    FIX: Use DNSPort 9053 (no conflict) and add a
    //    netsh portproxy rule: 127.0.0.1:53 -> 127.0.0.1:9053
    //    Windows adapters point to 127.0.0.1, hit the proxy,
    //    which forwards to Tor's actual DNS port. No conflict.
    //
    //  IPv6 fix: registry + adapter binding disable (unchanged)
    // ════════════════════════════════════════════════════════
    async function applyLeakProtection() {
        // ── DNS Leak Fix ──────────────────────────────────────────────
        // ipleak DNS test resolves a unique subdomain through the OS DNS
        // stack, NOT via SOCKS5 tunnel. So even with SOCKS5 proxy set,
        // DNS can still leak to ISP.
        //
        // Fast fix (no PowerShell = no 15s startup delay):
        //  1. netsh portproxy: 127.0.0.1:53 → 127.0.0.1:9053 (Tor DNS)
        //  2. reg NameServer = 127.0.0.1 (global DNS fallback, instant)
        //  3. ipconfig /flushdns (clear ISP cache)
        //
        // This routes ALL DNS queries through Tor's DNSPort 9053.
        // ── IPv6 Leak Fix ─────────────────────────────────────────────
        // SOCKS5 cannot carry IPv6. Disable at registry level (fast, 
        // no PowerShell). The adapter-level binding command is skipped 
        // because it requires slow PowerShell and can disrupt network.
        // Registry DisabledComponents=0xFF is sufficient for leak prevention.
        Logger.info('Applying DNS + IPv6 leak protection...');
        const bat = getScriptPath('fp_leak_on.bat');
        const content = [
            '@echo off',
            // ── DNS: portproxy 53 → 9053 (Tor's DNSPort) ──────────────
            // Remove any old rule first, then add fresh
            `netsh interface portproxy delete v4tov4 listenport=53 listenaddress=127.0.0.1 2>nul`,
            `netsh interface portproxy add v4tov4 listenport=53 listenaddress=127.0.0.1 connectport=9053 connectaddress=127.0.0.1`,
            // ── DNS: global registry fallback (fast, no PowerShell) ────
            `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters" /v "NameServer" /t REG_SZ /d "127.0.0.1" /f`,
            // ── DNS: flush stale ISP entries ────────────────────────────
            `ipconfig /flushdns`,
            // ── IPv6: registry disable (reboot-persistent, fast) ────────
            `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters" /v DisabledComponents /t REG_DWORD /d 255 /f`,
            // ── IPv6 tunnels ─────────────────────────────────────────────
            `netsh interface teredo set state disabled`,
            `netsh interface isatap set state disabled`,
            `netsh interface 6to4 set state disabled`,
        ].join('\r\n');
        await runBat(bat, content);
        Logger.success('Leak protection ON -- DNS->127.0.0.1:53->9053->Tor, IPv6 disabled');
    }

    async function reverseLeakProtection() {
        Logger.info('Reversing DNS + IPv6 leak protection...');
        const bat = getScriptPath('fp_leak_off.bat');
        const content = [
            '@echo off',
            // ── DNS: remove portproxy ─────────────────────────────────
            `netsh interface portproxy delete v4tov4 listenport=53 listenaddress=127.0.0.1 2>nul`,
            // ── DNS: restore global NameServer to empty (use DHCP) ────
            `reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters" /v "NameServer" /f 2>nul`,
            `ipconfig /flushdns`,
            // ── IPv6: re-enable via registry ──────────────────────────
            `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters" /v DisabledComponents /t REG_DWORD /d 0 /f`,
            // ── IPv6 tunnels: restore ──────────────────────────────────
            `netsh interface teredo set state default`,
            `netsh interface isatap set state default`,
            `netsh interface 6to4 set state default`,
        ].join('\r\n');
        await runBat(bat, content);
        Logger.success('Leak protection OFF -- DNS & IPv6 restored');
    }

    async function killSwitchLeakLock() {
        Logger.info('Kill Switch: blocking all traffic...');
        const bat = getScriptPath('fp_ks_leak.bat');
        const content = [
            '@echo off',
            // Dead proxy port -- blocks all internet traffic
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "socks=127.0.0.1:9999" /f`,
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`,
            // Keep DNS locked -- Tor is gone so DNS queries fail (no ISP leak)
            `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters" /v "NameServer" /t REG_SZ /d "127.0.0.1" /f`,
            // Keep IPv6 disabled
            `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters" /v DisabledComponents /t REG_DWORD /d 255 /f`,
        ].join('\r\n');
        await runBat(bat, content);
        Logger.warn('Kill Switch LOCKED -- internet blocked, DNS locked, IPv6 off');
    }

    // ── Window creation ───────────────────────────────────
    function createWindow() {
        Logger.info('Creating BrowserWindow...');

        // Geolocation permission auto-grant
        session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
            callback(true);
        });
        session.defaultSession.setPermissionCheckHandler(() => true);

        mainWindow = new BrowserWindow({
            width: 1000, height: 670, resizable: false, autoHideMenuBar: true,
            icon: path.join(__dirname, 'icon.png'),
            webPreferences: { nodeIntegration: true, contextIsolation: false }
        });
        mainWindow.loadFile('index.html');
        Logger.success('BrowserWindow ready');

        mainWindow.webContents.setWindowOpenHandler(({ url }) => {
            if (url.startsWith('http')) { shell.openExternal(url); return { action: 'deny' }; }
            return { action: 'allow' };
        });
        mainWindow.webContents.on('will-navigate', (e, url) => {
            if (url.startsWith('http') && !url.includes('localhost')) {
                e.preventDefault(); shell.openExternal(url);
            }
        });
    }

    // ── WebSocket server ──────────────────────────────────
    const wss = new WebSocket.Server({ port: 8080 });
    Logger.info('WebSocket server started on :8080');

    let appState = { connected: false, serverCode: 'us', killSwitch: false, bypassList: '', servers: {} };

    function broadcastState() {
        const msg = JSON.stringify({ type: 'STATE_SYNC', state: appState });
        wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
    }

    wss.on('connection', ws => {
        Logger.debug('Extension WS client connected');
        ws.send(JSON.stringify({ type: 'STATE_SYNC', state: appState }));
        ws.on('message', async raw => {
            const d = JSON.parse(raw);
            if (d.command === 'PING') return;
            const wc = BrowserWindow.getAllWindows()[0]?.webContents;
            if (!wc) return;
            if      (d.command === 'CONNECT')       wc.send('force-connect-ui');
            else if (d.command === 'DISCONNECT')    wc.send('force-disconnect-ui');
            else if (d.command === 'CHANGE_SERVER') { appState.serverCode = d.server; wc.send('sync-ui-state', appState); broadcastState(); }
            else if (d.command === 'TOGGLE_KS')     { appState.killSwitch = d.enabled; wc.send('sync-ui-state', appState); broadcastState(); }
            else if (d.command === 'UPDATE_BYPASS') { appState.bypassList = d.list; wc.send('sync-ui-state', appState); broadcastState(); }
        });
        ws.on('close', () => Logger.debug('Extension WS disconnected'));
    });

    // ── Startup sequence ──────────────────────────────────
    startupCleanup();
    setupWritableTor();
    firstRunCheck();
    createWindow();

    // ── App close ─────────────────────────────────────────
    app.on('window-all-closed', async () => {
        Logger.info('window-all-closed -- cleanup...');
        if (mainWindow) clearGeolocationSpoof(mainWindow);
        try {
            exec('taskkill /F /IM tor.exe', { windowsHide: true });
            await runBat(getScriptPath('fp_exit.bat'), [
                '@echo off',
                `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
                `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "" /f`,
            ].join('\r\n'));
            await reverseLeakProtection();
        } catch(e) { Logger.error('Exit cleanup error', { err: e.message }); }
        Logger.info('Goodbye.');
        if (process.platform !== 'darwin') app.quit();
    });

    // ════════════════════════════════════════════════════════
    //  IPC HANDLERS
    // ════════════════════════════════════════════════════════
    ipcMain.handle('get-log-lines', async (e, { n, level }) => ({
        lines: Logger.tail(n || 400, level || 'ALL'), logFile: Logger.getLogFile()
    }));
    ipcMain.handle('open-log-folder', async () => { shell.openPath(Logger.getLogDir()); });
    ipcMain.handle('get-fastest-server', async () => ({ best: 'sg', others: ['hk', 'jp'] }));

    // ── Live relay status ─────────────────────────────────
    let cachedRelays = null, lastFetchTime = 0;

    ipcMain.handle('get-realtime-status', async () => {
        const now = Date.now();
        if (cachedRelays && now - lastFetchTime < 20000) return cachedRelays;
        // Skip live fetch when connected: Node.js fetch() does not use
        // Windows SOCKS proxy, so requests timeout through Tor.
        // Use cached data during active sessions.
        if (appState.connected) {
            Logger.debug('Connected -- skipping relay fetch, using cached data');
            return cachedRelays || {};
        }
        Logger.info('Fetching live Tor relay data...');

        const fetchJSON = async (url, ms) => {
            try {
                const ctl = new AbortController();
                const tid = setTimeout(() => ctl.abort(), ms);
                const res = await fetch(url, { signal: ctl.signal });
                clearTimeout(tid);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            } catch(e) { Logger.warn(`fetchJSON failed: ${url}`, { err: e.message }); return null; }
        };

        const base = 'https://onionoo.torproject.org/details?type=relay&running=true&fields=country,observed_bandwidth';
        let data = await fetchJSON(base, 6000)
                || await fetchJSON('https://api.allorigins.win/raw?url=' + encodeURIComponent(base), 6000);

        if (data?.relays?.length) {
            const stats = {};
            data.relays.forEach(r => {
                if (!r.country) return;
                const cc = r.country.toLowerCase();
                if (!stats[cc]) stats[cc] = { count: 0, bandwidth: 0 };
                stats[cc].count++;
                stats[cc].bandwidth += r.observed_bandwidth || 0;
            });
            if (Object.keys(stats).length) {
                Logger.success(`Relay data: ${Object.keys(stats).length} countries, ${data.relays.length} relays`);
                cachedRelays = stats; appState.servers = stats;
                broadcastState(); lastFetchTime = now; return stats;
            }
        }
        Logger.warn('Relay fetch failed -- using fallback');
        if (cachedRelays) return cachedRelays;
        return {
            "us":{"count":1200,"bandwidth":12000000000},"de":{"count":900,"bandwidth":9000000000},
            "fr":{"count":600,"bandwidth":6000000000},"nl":{"count":500,"bandwidth":5000000000},
            "gb":{"count":400,"bandwidth":4000000000},"ca":{"count":250,"bandwidth":2500000000},
            "ch":{"count":200,"bandwidth":2000000000},"se":{"count":180,"bandwidth":1800000000},
            "sg":{"count":150,"bandwidth":1500000000},"fi":{"count":130,"bandwidth":1300000000},
            "no":{"count":100,"bandwidth":1000000000},"jp":{"count":120,"bandwidth":1200000000},
            "au":{"count":80,"bandwidth":800000000},"at":{"count":75,"bandwidth":750000000},
            "pl":{"count":70,"bandwidth":700000000},"ro":{"count":60,"bandwidth":600000000},
            "dk":{"count":55,"bandwidth":550000000},"be":{"count":45,"bandwidth":450000000},
            "cz":{"count":35,"bandwidth":350000000},"es":{"count":30,"bandwidth":300000000},
            "it":{"count":25,"bandwidth":250000000},"ie":{"count":20,"bandwidth":200000000},
            "lu":{"count":15,"bandwidth":150000000},"in":{"count":5,"bandwidth":50000000},
            "bd":{"count":1,"bandwidth":10000000}
        };
    });

    // ════════════════════════════════════════════════════════
    //  CONNECT VPN
    //
    //  KEY FIX: DNSPort is now 9053, not 53.
    //
    //  Why 9053?
    //    Port 53 on Windows is held by the "DNS Client" service
    //    (dnscache / svchost). tor.exe tries to bind 127.0.0.1:53
    //    but fails silently -- tor.exe exits or misbehaves, log
    //    file never gets bootstrap lines, pollLog reads 0% forever,
    //    stall timer fires after 35s -> "unavailable".
    //
    //    Port 9053 is free. Tor binds it successfully.
    //    applyLeakProtection() adds a portproxy rule:
    //      127.0.0.1:53 -> 127.0.0.1:9053
    //    Adapters DNS = 127.0.0.1 -> portproxy -> Tor's DNS.
    //    No conflict. No 0% stall.
    //
    //  Note: applyLeakProtection runs AFTER bootstrap completes,
    //  so Tor bootstraps using the system's existing DNS (DHCP).
    //  Only after connection is proven do we lock DNS to Tor.
    // ════════════════════════════════════════════════════════
    ipcMain.handle('connect-vpn', async (event, data) => {
        return new Promise(resolve => {
            const { serverCode, bypassList } = data;
            const SOCKS_PORT = 9050;
            const DNS_PORT   = 9053;
            const wc = BrowserWindow.getAllWindows()[0]?.webContents;
            Logger.info('connect-vpn', { serverCode });

            function sendProgress(pct, msg, status = 'connecting') {
                Logger.debug(`Bootstrap ${pct}% [${status}] ${msg}`);
                wc?.send('connection-progress', { percent: pct, message: msg, status, serverCode });
            }

            try { execSync('taskkill /F /IM tor.exe /IM lyrebird.exe', { stdio: 'ignore', windowsHide: true }); } catch(e) {}

            const torExe      = path.join(torDir, 'tor.exe');
            const torParent   = path.dirname(torDir);
            const torData     = path.join(torParent, 'data');
            const geoip       = path.join(torData,  'geoip');
            const geoip6      = path.join(torData,  'geoip6');
            const torrcPath   = getScriptPath('torrc');
            const lyrePath    = path.join(torDir, 'pluggable_transports', 'lyrebird.exe');
            const hasLyrebird = fs.existsSync(lyrePath);

            if (!fs.existsSync(torExe)) {
                Logger.error('tor.exe not found', { path: torExe });
                sendProgress(0, 'Tor engine not found. Please reinstall.', 'unavailable');
                return resolve({ status: 'unavailable', serverCode });
            }

            [path.join(torData, 'lock'), path.join(torDir, 'data', 'lock')]
                .forEach(lf => { try { if (fs.existsSync(lf)) { fs.unlinkSync(lf); Logger.debug('Deleted lock', { lf }); } } catch(e) {} });

            // ────────────────────────────────────────────────────
            //  ROOT CAUSE FIX: exec() -- spawn()
            //
            //  exec() passes the command through cmd.exe shell.
            //  Username "User pc" has a space -- cmd.exe quoting
            //  breaks the -f argument silently:
            //    cmd /c ""C:\Users\User pc\...\tor.exe" -f ..."
            //  tor.exe gets a garbled path, fails to read torrc,
            //  exits with code 1 in under 0.5 seconds.
            //
            //  spawn() passes executable + args as separate OS
            //  arguments, bypassing the shell entirely.
            //  Spaces in paths are handled natively by Windows.
            //
            //  BONUS: stderr captured via pipe -- no log FILE
            //  needed, which eliminates the secondary issue of
            //  "Log notice file PATH WITH SPACES" in torrc.
            // ────────────────────────────────────────────────────

            function buildTorrc(useBridges) {
                const lines = [
                    `SocksPort ${SOCKS_PORT}`,
                    `DNSPort ${DNS_PORT}`,
                    `AutomapHostsOnResolve 1`,
                    `VirtualAddrNetworkIPv4 10.192.0.0/10`,
                    `ClientUseIPv4 1`,
                    `ClientUseIPv6 0`,
                    `DataDirectory "${torData.replace(/\\/g, '/')}"`,
                    `GeoIPFile "${geoip.replace(/\\/g, '/')}"`,
                    `GeoIPv6File "${geoip6.replace(/\\/g, '/')}"`,
                    `ExitNodes {${serverCode}}`,
                    `StrictNodes 1`,
                    // Long circuit lifetime prevents exit country switching
                    `MaxCircuitDirtiness 3600`,    // keep circuit 1 hour (was 10s!)
                    `NewCircuitPeriod 600`,         // don't build new ones for 10min
                    `LongLivedPorts 9050`,          // SOCKS port gets sticky long-lived circuits
                    `CircuitBuildTimeout 60`,        // more time to find a good exit
                    `Log notice stderr`,
                    // ControlPort for NEWNYM signal (country re-verification)
                    `ControlPort 9051`,
                ];
                if (useBridges && hasLyrebird) {
                    lines.push(`UseBridges 1`);
                    lines.push(`ClientTransportPlugin obfs4 exec "${lyrePath.replace(/\\/g, '/')}"`);
                    lines.push(`Bridge obfs4 146.57.248.225:22 10A6CD36A537FCE513A322361547444B393989F0 cert=K1gAVGcKRMVJaRJGaFoMK0IQWY9HfRRmRPf6VWB7uIKwFoiX3y7GFhRvmFMKOgA3FScOQ iat-mode=0`);
                    lines.push(`Bridge obfs4 109.105.109.165:10527 8DFCD8FB3285E855F5A55BDCD4E1DB1AEDB3F8B6 cert=XCHbbbz2aO5B8iVKQV+sNqz8CxCaU7FHWNiQyPFKXYZBiQFHpOq73VKwIq0KPrOJYA iat-mode=0`);
                    lines.push(`Bridge obfs4 45.145.95.6:27015 C5B7CD6946FF10C5B3E89691A7D3F2C122D2117C cert=TD7bwPBhFCFRlSPaG/dPFRhTbT14q4ExKb0C1Jze8P7WRvDJW9nWz9wWe4xdGEi+5u5yqA iat-mode=0`);
                    Logger.warn('Bridge mode: obfs4 enabled');
                }
                return lines.join('\n');
            }

            let resolved       = false;
            let lastPercent    = 0;
            let lastProgressAt = Date.now();
            const startedAt    = Date.now();
            let slowWarned     = false;
            let bridgeRetried  = false;
            let pollId         = null;
            let maxTimer       = null;
            let activeTorProc  = null;

            const BRIDGE_RETRY_MS = 20000;
            const STALL_MS        = 40000;
            const SLOW_WARN_MS    = 22000;
            const MAX_MS          = 120000;

            function killTor() {
                if (activeTorProc) { try { activeTorProc.kill(); } catch(e) {} activeTorProc = null; }
                try { execSync('taskkill /F /IM tor.exe /IM lyrebird.exe', { stdio: 'ignore', windowsHide: true }); } catch(e) {}
            }

            function finish(status) {
                if (resolved) return;
                resolved = true;
                if (pollId)   clearInterval(pollId);
                if (maxTimer) clearTimeout(maxTimer);
                if (status === 'connected') Logger.success(`Connected via ${serverCode}`);
                else { Logger.warn('Connection failed', { serverCode, status }); killTor(); }
                resolve({ status, serverCode });
            }

            // Parse a line from tor's stderr/stdout
            function parseTorLine(raw) {
                if (resolved || !raw.trim()) return;
                const line = raw.trim();

                // Log errors and warnings from Tor
                if (line.includes('[err]') || line.includes('[warn]')) {
                    Logger.warn(`TOR: ${line}`);
                }

                const m = line.match(/Bootstrapped (\d+)%[^:]*:\s*(.*)/);
                if (!m) return;

                const pct = parseInt(m[1]);
                const msg = m[2].trim();

                if (pct > lastPercent) {
                    lastPercent    = pct;
                    lastProgressAt = Date.now();
                    slowWarned     = false;
                    Logger.info(`Bootstrap: ${pct}% -- ${msg}`);
                    sendProgress(pct, msg, 'connecting');
                }

                if (pct >= 100) {
                    resolved = true;
                    if (pollId)   clearInterval(pollId);
                    if (maxTimer) clearTimeout(maxTimer);
                    sendProgress(97, 'Setting up secure proxy...', 'connected');

                    // ── Set SOCKS proxy first, IPv6 disable in background ──
                    const proxyBat = getScriptPath('fp_conn.bat');
                    runBat(proxyBat, buildProxyBat(SOCKS_PORT, bypassList)).then(async () => {
                        Logger.success(`SOCKS proxy set -> 127.0.0.1:${SOCKS_PORT}`);
                        applyLeakProtection(); // background

                        sendProgress(98, 'Verifying exit country...', 'connected');

                        // Verify actual exit IP country matches requested country
                        const { verified, actual } = await verifyAndFixExitCountry(
                            serverCode, SOCKS_PORT, 9051
                        );

                        let finalCode = serverCode;
                        if (actual && !verified) {
                            // Couldn't get matching exit after 3 tries —
                            // connect anyway but report the actual country
                            Logger.warn(`Final exit country: ${actual} (requested: ${serverCode.toUpperCase()})`);
                            finalCode = actual.toLowerCase();
                            sendProgress(100, `Connected via ${actual}`, 'connected');
                        } else {
                            sendProgress(100, `Connected via ${serverCode.toUpperCase()}`, 'connected');
                        }

                        appState.connected  = true;
                        appState.serverCode = finalCode;
                        broadcastState();
                        if (mainWindow) applyGeolocationSpoof(mainWindow, finalCode);
                        resolve({ status: 'connected', serverCode: finalCode });
                    });
                }
            }

            // ════════════════════════════════════════════════
            //  EXIT COUNTRY VERIFICATION
            //
            //  Problem: Tor uses its bundled geoip to pick an exit
            //  relay from the requested country. But that relay's IP
            //  may be geolocated differently by external services
            //  (ipleak, ipinfo) causing apparent "wrong country".
            //
            //  Fix:
            //   1. After proxy is set, use Windows curl.exe to GET
            //      https://ipinfo.io/country through the SOCKS5 proxy
            //      -- this reveals what the exit IP actually is.
            //   2. If wrong, send SIGNAL NEWNYM via Tor ControlPort
            //      to force a new circuit (new exit relay).
            //   3. Retry up to 3 times.
            //
            //  curl.exe ships with Windows 10 1803+ at System32.
            //  ControlPort 9051 is now added to torrc (no password,
            //  bound to 127.0.0.1 only -- safe).
            // ════════════════════════════════════════════════

            // Get actual exit country via curl through SOCKS5
            function getActualExitCountry(socksPort) {
                return new Promise(resolveInner => {
                    const curlExe = path.join(
                        process.env.SystemRoot || 'C:\\Windows',
                        'System32', 'curl.exe'
                    );
                    if (!fs.existsSync(curlExe)) {
                        Logger.debug('curl.exe not found -- skipping exit country check');
                        resolveInner(null); return;
                    }
                    const proc = spawn(curlExe, [
                        '--socks5-hostname', `127.0.0.1:${socksPort}`,
                        '--max-time', '12',
                        '--silent', '--fail',
                        'https://ipinfo.io/country'
                    ], { windowsHide: true, stdio: 'pipe' });

                    let out = '';
                    proc.stdout.on('data', d => out += d.toString());
                    proc.on('exit', () => {
                        const cc = out.trim().toUpperCase();
                        // ipinfo returns 2-letter ISO code
                        resolveInner(cc.length === 2 ? cc : null);
                    });
                    proc.on('error', () => resolveInner(null));
                    setTimeout(() => { try { proc.kill(); } catch(e) {} resolveInner(null); }, 14000);
                });
            }

            // Ask Tor for a new circuit via ControlPort
            function requestNewCircuit(ctrlPort) {
                return new Promise(resolveInner => {
                    const net = require('net');
                    const sock = new net.Socket();
                    let buf = '', authed = false;

                    sock.connect(ctrlPort, '127.0.0.1', () => {
                        sock.write('AUTHENTICATE ""');
                    });
                    sock.on('data', chunk => {
                        buf += chunk.toString();
                        if (!authed && buf.includes('250 OK')) {
                            authed = true; buf = '';
                            sock.write('SIGNAL NEWNYM');
                        } else if (authed && buf.includes('250 OK')) {
                            sock.destroy(); resolveInner(true);
                        } else if (buf.includes('515') || buf.includes('551')) {
                            sock.destroy(); resolveInner(false);
                        }
                    });
                    sock.on('error', () => resolveInner(false));
                    setTimeout(() => { try { sock.destroy(); } catch(e) {} resolveInner(false); }, 6000);
                });
            }

            // Verify + retry if needed (up to 3 circuits)
            async function verifyAndFixExitCountry(serverCode, socksPort, ctrlPort) {
                const want = serverCode.toUpperCase();
                for (let attempt = 1; attempt <= 3; attempt++) {
                    const got = await getActualExitCountry(socksPort);
                    if (!got) return { verified: false, actual: null }; // curl unavailable

                    Logger.info(`Exit country check #${attempt}: want=${want}, got=${got}`);
                    if (got === want) {
                        Logger.success(`Exit country confirmed: ${got}`);
                        return { verified: true, actual: got };
                    }

                    if (attempt < 3) {
                        Logger.warn(`Exit mismatch (${got} != ${want}), requesting new circuit...`);
                        const ok = await requestNewCircuit(ctrlPort);
                        if (!ok) { Logger.warn('NEWNYM failed'); break; }
                        // Wait for new circuit to establish
                        await new Promise(r => setTimeout(r, 5000));
                    }
                }
                const final = await getActualExitCountry(socksPort);
                return { verified: final === want, actual: final };
            }

            function startTor(useBridges) {
                killTor();
                [path.join(torData, 'lock'), path.join(torDir, 'data', 'lock')]
                    .forEach(lf => { try { if (fs.existsSync(lf)) fs.unlinkSync(lf); } catch(e) {} });

                fs.writeFileSync(torrcPath, buildTorrc(useBridges), 'utf8');
                Logger.info('Spawning tor.exe', { useBridges, serverCode });

                // spawn() with separate args array -- no shell, no quoting issues
                activeTorProc = spawn(torExe, ['-f', torrcPath], {
                    cwd:         torDir,
                    windowsHide: true,
                    stdio:       ['ignore', 'pipe', 'pipe'],
                });

                let buf = '';
                function handleData(chunk) {
                    buf += chunk.toString('utf8');
                    const lines = buf.split('\n');
                    buf = lines.pop() || '';
                    lines.forEach(parseTorLine);
                }

                activeTorProc.stdout.on('data', handleData);
                activeTorProc.stderr.on('data', handleData);
                activeTorProc.on('exit', (code, signal) => {
                    if (buf.trim()) parseTorLine(buf); buf = '';
                    Logger.warn('tor.exe exited', { code, signal, useBridges });
                });
            }

            // Stall/slow detection ticker (independent of line events)
            function pollState() {
                if (resolved) return;
                const now     = Date.now();
                const elapsed = now - startedAt;
                const stall   = now - lastProgressAt;

                // Bridge retry
                if (!bridgeRetried && hasLyrebird && elapsed > BRIDGE_RETRY_MS && lastPercent === 0) {
                    bridgeRetried  = true;
                    lastProgressAt = now;
                    Logger.warn('Direct stalled -- retrying with bridges', { serverCode });
                    sendProgress(0, 'Switching to bridge mode...', 'connecting');
                    startTor(true); return;
                }

                // Stall abort
                if (stall > STALL_MS) {
                    Logger.error(`Stalled at ${lastPercent}% for ${Math.round(stall/1000)}s`, { serverCode, bridgeRetried });
                    sendProgress(lastPercent, 'Server not responding. Aborting...', 'unavailable');
                    finish('unavailable'); return;
                }

                // Slow warning
                if (!slowWarned && elapsed > SLOW_WARN_MS && lastPercent < 40) {
                    slowWarned = true;
                    const rate    = lastPercent > 0 ? lastPercent / elapsed : 0;
                    const estSecs = Math.min(Math.round(rate > 0 ? (100 - lastPercent) / rate / 1000 : 60), 120);
                    Logger.warn(`Slow: ${lastPercent}% after ${Math.round(elapsed/1000)}s`, { serverCode });
                    sendProgress(lastPercent, `Server is slow... (~${estSecs}s remaining)`, 'slow');
                } else if (lastPercent === 0 && elapsed > 3000) {
                    sendProgress(0, 'Building anonymous circuits...', 'connecting');
                }
            }

            sendProgress(0, 'Starting Tor Engine...', 'connecting');
            startTor(false);
            pollId   = setInterval(pollState, 1000);
            maxTimer = setTimeout(() => {
                Logger.error(`Timeout after ${MAX_MS/1000}s`, { serverCode });
                sendProgress(lastPercent, 'Connection timed out.', 'unavailable');
                finish('unavailable');
            }, MAX_MS);
        });
    });

    ipcMain.handle('disconnect-vpn', async (event, isKillSwitchOn) => {
        Logger.info('disconnect-vpn', { killSwitch: isKillSwitchOn });
        return new Promise(resolve => {
            exec('taskkill /F /IM tor.exe', { windowsHide: true }, async () => {
                Logger.debug('tor.exe terminated');
                if (mainWindow) clearGeolocationSpoof(mainWindow);
                if (isKillSwitchOn) {
                    await killSwitchLeakLock();
                } else {
                    await runBat(getScriptPath('fp_disconn.bat'), [
                        '@echo off',
                        `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
                        `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "" /f`,
                    ].join('\r\n'));
                    await reverseLeakProtection();
                }
                appState.connected = false; broadcastState();
                Logger.success('VPN disconnected');
                resolve({ status: 'disconnected' });
            });
        });
    });

    // ── Kill Switch ───────────────────────────────────────
    ipcMain.handle('toggle-killswitch', async (event, isEnabled) => {
        Logger.info('toggle-killswitch', { enabled: isEnabled });
        appState.killSwitch = isEnabled; broadcastState();
        if (isEnabled) {
            await killSwitchLeakLock();
        } else {
            await runBat(getScriptPath('fp_ks_off.bat'), [
                '@echo off',
                `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
                `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "" /f`,
            ].join('\r\n'));
            await reverseLeakProtection();
        }
        return { status: 'done' };
    });

    // ── Live bypass update ────────────────────────────────
    ipcMain.handle('update-live-bypass', async (event, bypassList) => {
        Logger.info('update-live-bypass', { bypassList });
        return new Promise(resolve => {
            appState.bypassList = bypassList; broadcastState();
            let fp = '<local>';
            if (bypassList && bypassList.trim()) {
                const parts = bypassList.replace(/,/g, ';').split(';')
                    .map(s => { const c = s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[\*\s]/g, ''); return c ? `*${c}*` : ''; })
                    .filter(Boolean);
                if (parts.length) fp = parts.join(';') + ';<local>';
            }
            // REMOVED: Set-DnsClientServerAddress was crashing WiFi adapter
            // when split tunneling was updated while connected.
            // DNS is locked by applyLeakProtection() at connect time.
            // Only ProxyOverride needs to change for bypass updates.
            runBat(getScriptPath('fp_bypass.bat'), [
                '@echo off',
                `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "${fp}" /f`,
            ].join('\r\n')).then(() => { Logger.debug('Bypass updated', { fp }); resolve({ status: 'updated' }); });
        });
    });
}