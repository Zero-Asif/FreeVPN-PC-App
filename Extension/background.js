const desktopAppUrl = "ws://127.0.0.1:8080"; 
let socket = null;
let keepAliveInterval = null;
// গ্লোবাল স্ট্যাটাস যা অ্যাপের সাথে সিঙ্ক হবে
let globalState = { connected: false, server: 'us', killSwitch: false, bypassList: '', appRunning: false };

function setBrowserProxy(enabled) {
    if (enabled) {
        chrome.proxy.settings.set({ value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: "127.0.0.1", port: 9050 }, bypassList: ["localhost", "127.0.0.1"] } }, scope: 'regular' });
    } else {
        chrome.proxy.settings.clear({ scope: 'regular' });
    }
}

function keepAlive() {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    keepAliveInterval = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ command: "PING" }));
    }, 20000);
}

function connectToDesktop() {
    socket = new WebSocket(desktopAppUrl);
    
    socket.onopen = () => { globalState.appRunning = true; keepAlive(); };

    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "STATE_SYNC") {
            // অ্যাপ থেকে আসা রিয়েল-টাইম ডাটা সেভ করা
            globalState = { ...globalState, ...data.state, appRunning: true };
            setBrowserProxy(globalState.connected);
            chrome.runtime.sendMessage({ type: "UI_UPDATE", state: globalState }).catch(()=>{});
        }
    };

    socket.onclose = () => {
        globalState.appRunning = false; globalState.connected = false;
        setBrowserProxy(false);
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        chrome.runtime.sendMessage({ type: "UI_UPDATE", state: globalState }).catch(()=>{});
        setTimeout(connectToDesktop, 3000); 
    };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_STATUS") {
        sendResponse({ state: globalState });
        return true;
    }
    if (msg.type === "SEND_COMMAND" && socket && socket.readyState === WebSocket.OPEN) {
        // পপআপ থেকে আসা কমান্ড ডেস্কটপ অ্যাপে পাঠানো
        socket.send(JSON.stringify(msg.payload));
    }
});

connectToDesktop();