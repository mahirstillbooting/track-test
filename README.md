# ESP32 Live GPS Tracker 🛰️📍

> **Demo / Test Run**: Experimental IoT tracking pipeline testing **ESP32 Hardware $\rightarrow$ Firebase Realtime Database updates $\rightarrow$ Live Web Map Interface**.

Hosted on GitHub Pages: [https://mahirstillbooting.github.io/track-test/](https://mahirstillbooting.github.io/track-test/)

---

## 🌟 Overview

This project is a lightweight, zero-build-tool live GPS tracking web application built to receive realtime telemetry from an **ESP32 microcontroller** paired with a **NEO-6M/7M/8M GPS module**. 

The app visualizes real-time location, movement speed, satellite fix quality (HDOP), active sharing state, and historical journey polyline routes.

---

## 🛠️ Architecture & Tech Stack

```
┌─────────────────┐       HTTPS       ┌────────────────────────┐       WebSockets      ┌─────────────────────────┐
│ ESP32 + NEO-6M  │ ────────────────> │ Firebase Realtime DB   │ ───────────────────> │ Web App (GitHub Pages)  │
│ GPS Hardware    │  REST (PUT/POST)  │ (track-test-4ddde)     │  Realtime Listeners  │ Leaflet.js + Esri Tiles │
└─────────────────┘                   └────────────────────────┘                      └─────────────────────────┘
```

- **Frontend**: Plain HTML5, CSS3, JavaScript (ES6+). Zero Node.js / React / npm / bundler required.
- **Mapping**: [Leaflet.js](https://leafletjs.com/) with open Esri World Street Map tile tiles.
- **Backend / Realtime Database**: Firebase Realtime Database (RTDB) via Firebase Web SDK CDN scripts.
- **Hardware Firmware**: ESP32 C++ Arduino Sketch (`esp32_tracker.ino`) using `TinyGPS++` and native HTTPS REST API.

---

## 📱 Interface Modes

### 1. Passenger Mode
- Live map tracking with smooth, interpolated marker movement (60fps via `requestAnimationFrame`).
- Realtime telemetry cards:
  - **Sharing Status**: `ACTIVE` / `STOPPED`
  - **Speed**: Velocity in km/h
  - **Satellites**: Visible GPS satellite count
  - **GPS HDOP**: Precision / horizontal dilution of precision
  - **Last Updated**: Realtime event timestamp

### 2. Admin Mode
- Includes all Passenger mode telemetry metrics.
- **Show Current Journey**: Reads `tracker/journey` coordinates and plots the active route as a Leaflet polyline.
- **Save & Start New Trip**: Archives current journey points into `history/` in Firebase RTDB with timestamp labels, then resets the active journey path for the next trip.
- **View Past Journeys**: Interactive dropdown selector to load and display any previously archived trip route from database history.
- **Clear Map Display**: Clears polylines from map view without deleting database data.

---

## 🗄️ Firebase Realtime Database Schema

```
https://track-test-4ddde-default-rtdb.asia-southeast1.firebasedatabase.app/
├── tracker/
│   ├── active: true / false
│   ├── current/
│   │   ├── lat: 23.8103
│   │   ├── lng: 90.4125
│   │   ├── speedKmh: 12.5
│   │   ├── satellites: 8
│   │   ├── hdop: 1.1
│   │   └── timestamp: 1690000000
│   └── journey/
│       └── <pushId>: { lat: 23.8103, lng: 90.4125, timestamp: 1690000000 }
└── history/
    └── <archiveId>/
        ├── title: "Trip on 9/28/2026, 12:46 AM"
        ├── savedAt: 1790534600000
        └── points: { ... }
```

---

## 🔌 Hardware Setup & Pinout

### Components Needed:
1. **ESP32 DevKit v1** Development Board.
2. **NEO-6M / NEO-7M / NEO-8M** GPS Module.
3. Wi-Fi Access Point / Mobile Hotspot.

### Wiring Diagram:

| NEO-6M GPS Module | ESP32 Pin | Notes |
| :--- | :--- | :--- |
| **VCC** | `3.3V` / `5V` | Power supply |
| **GND** | `GND` | Common ground |
| **TX** | `GPIO 16` (RX2) | Serial UART Receive |
| **RX** | `GPIO 17` (TX2) | Serial UART Transmit |

---

## 🚀 How to Run / Host

### A. Hosting on GitHub Pages
1. Push this repository to GitHub under `mahirstillbooting/track-test`.
2. Go to **Settings** $\rightarrow$ **Pages** in your GitHub repository.
3. Under **Build and deployment** $\rightarrow$ **Branch**, select `main` (or `master`) and folder `/ (root)`.
4. Click **Save**. GitHub Pages will deploy your site live!

### B. Running Locally
Simply open `index.html` directly in any web browser, or launch a simple local HTTP server:
```bash
python -m http.server 8080
```
Then visit `http://localhost:8080`.

---

## 📄 License & Status

This repository is maintained by **mahirstillbooting** as an open demo and proof-of-concept for ESP32 live GPS tracking pipeline testing.
