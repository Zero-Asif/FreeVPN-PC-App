# FreeProxy VPN - Premium Tor-Backed Experience

<p align="center">
  <img src="https://capsule-render.vercel.app/render?type=waving&color=gradient&height=280&section=header&text=FreeProxy%20VPN&fontSize=80&animation=fadeIn&fontAlignY=35&desc=High-Performance%20Tor%20Privacy%20Tool&descAlignY=55&descSize=25" width="100%" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Release-v1.0.0-6e3985?style=for-the-badge&logo=github" />
  <img src="https://img.shields.io/badge/Platform-Windows-0078D4?style=for-the-badge&logo=windows" />
  <img src="https://img.shields.io/badge/Built%20With-Electron-47848F?style=for-the-badge&logo=electron" />
  <img src="https://img.shields.io/badge/Network-Tor%20Network-7D4698?style=for-the-badge&logo=torproject" />
</p>

---

## 🛡️ Project Overview

**FreeProxy VPN** is a robust, premium open-source VPN solution built on the **Tor Network**. Unlike traditional VPNs that may log your data, FreeProxy ensures 100% encryption and anonymity by routing your traffic through three different global nodes. It is specifically optimized for Windows power users who demand privacy without compromising on ease of use.

---

## ✨ Key Features

| Feature | Description |
| :--- | :--- |
| 🛡️ **Military-Grade Privacy** | Uses Tor’s 3-layer encryption, making your traffic virtually untraceable. |
| ⚡ **Smart Caching** | Enhanced persistence layer allows connection in just 3-5 seconds after initial bootstrap. |
| 🛑 **Advanced Kill Switch** | Instantly blocks internet access if the VPN connection drops to prevent IP leaks. |
| 🌐 **Split Tunneling** | Exclude specific websites or domains from the VPN tunnel with ease. |
| 🌉 **Obfs4 Bridge Support** | Built-in support for **Lyrebird (obfs4)** to bypass strict ISP firewalls and censorship. |
| 💎 **Premium UI/UX** | Modern Dark Mode interface with real-time ping tracking and reverse countdowns. |

---

## 📸 Screenshots

![Main Interface](https://i.ibb.co/fac3f25c/image-4bfec5.jpg)
![Privacy Verification](https://i.ibb.co/ab999968/image-abddad.jpg)

---

## 🛠️ Installation & Setup

Follow these steps to set up the project locally:

### 1. Clone the Repository
```bash
git clone [https://github.com/Zero-Asif/FreeVPN-PC-App.git](https://github.com/Zero-Asif/FreeVPN-PC-App.git)
```

### 2. Install Dependencies
```bash
cd FreeVPN-PC-App
npm install
```

### 3. Run the Application
```bash
npm start
```

> [!IMPORTANT]
> Ensure that the `Tor/data` folder contains the required `geoip` and `geoip6` files. The app automatically requests **Administrator** privileges to configure system proxy settings effectively.

---

## 🏗️ Technical Architecture

```mermaid
graph TD
    A[Electron Frontend] -->|IPC Communication| B[Node.js Backend]
    B -->|Registry/Shell Script| C[Tor Engine]
    C -->|Bridges/obfs4| D[Tor Entry Node]
    D --> E[Tor Middle Node]
    E --> F[Tor Exit Node]
    F -->|Encrypted Access| G[World Wide Web]
```

---

## 👨‍💻 Developed By

[![Zero-Asif](https://img.shields.io/badge/ZERO--ASIF-Full%20Stack%20Developer-orange?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Zero-Asif)

---

<p align="center">
  <img src="https://img.shields.io/badge/Made%20with-❤️-red?style=for-the-badge" />
  <img src="https://img.shields.io/badge/In-Bangladesh-green?style=for-the-badge" />
</p>