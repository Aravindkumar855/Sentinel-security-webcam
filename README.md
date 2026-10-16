# Sentinel — Security Webcam & Multi-Device Surveillance System

Sentinel is a security webcam web application inspired by AlfredCamera. It transforms smartphones, tablets, and computers into an interconnected security surveillance network with real-time peer-to-peer WebRTC streaming, video recording, playback, motion detection, and instant visitor alerts.

---

## 🌟 Key Features

### 1. Multi-Device Real-Time WebRTC Streaming
- **Peer-to-Peer Video**: Direct low-latency encrypted streaming between devices using WebRTC (`RTCPeerConnection`).
- **Flexible Modes**:
  - **Viewer Mode**: Monitor feeds, switch between multiple remote cameras, capture live snapshots, trigger remote recordings, and review logs.
  - **Camera Broadcaster Mode**: Turn an old smartphone, tablet, or secondary laptop into an active security camera with front/rear lens selection and audio consent.
- **Configurable STUN & TURN**: Default Google STUN servers with configurable TURN relay support for devices located across different networks and NAT firewalls.

### 2. High-Definition Recording & Playback
- **MediaRecorder Engine**: Dynamically detects supported browser codecs (`video/webm;codecs=vp9`, `vp8`, `video/mp4`).
- **Dual-Tier Storage Architecture**:
  - **IndexedDB**: Video blobs and rich metadata are saved directly in browser storage for instant local retrieval across page reloads.
  - **Authenticated Server Sync**: RESTful `/api/recordings` endpoint with chunked streaming and HTTP 206 Partial Content support for seeking.
- **Dedicated Video Player**:
  - Custom HTML5 timeline scrubber.
  - Play, pause, seek, playback speed (0.5x, 1x, 1.5x, 2x), volume/mute controls, and full-screen view.
  - One-click downloads with timestamped file naming.
  - Confirmation before deletion.

### 3. Device Management & Pairing
- **Secure Pairing Codes**: Single-use, expiring 6-digit pairing codes with brute-force rate-limiting.
- **QR Code Pairing**: Client-side SVG QR code generator for instant phone pairing.
- **Device Management**:
  - Customize camera names (e.g., *Front Door*, *Living Room*, *Backyard*, *Garage*).
  - Real-time status indicators (Online, Offline, Connecting, Reconnecting).
  - Last-seen timestamps, remote disconnection, and device revocation.

### 4. Motion Detection & Security Logbook
- **Pixel-Difference Analysis**: Fast 64×36 downsampled frame comparison with customizable sensitivity and cooldown intervals.
- **Person Filter**: Distinguishes upright person-shaped movement from pets or background noise.
- **Automatic Event Flagging**: Identifies unusual patterns such as *After hours* (10 PM – 6 AM), *While away*, *Repeat visit*, and *Lingering*.
- **Auto-Record on Motion**: Automatically captures a 10-second video clip whenever a visitor is detected.
- **Audio & Push Alerts**: Web Audio API two-tone synthesised chime and browser desktop notifications.

---

## 🏗️ Architecture

```
sentinel/
├── public/
│   ├── index.html            # Main application UI and view sections
│   ├── style.css             # Root stylesheet
│   ├── css/
│   │   └── style.css         # Responsive theme, badges, modals, player
│   └── js/
│       ├── qrcode.js         # Client-side QR code generator
│       ├── db.js             # IndexedDB storage wrapper
│       ├── webrtc.js         # WebRTC peer connection & stream lifecycle
│       ├── recorder.js       # MediaRecorder engine with codec detection
│       ├── app.js            # Core application state & UI coordinator
│       └── script.js         # Compatibility layer preserving original symbols
├── server/
│   ├── server.js             # Express & Socket.IO server startup
│   ├── db.js                 # SQLite schema initialization (Node 24 DatabaseSync)
│   ├── auth.js               # Session tokens, OTP generation & verification
│   ├── signaling.js          # Socket.IO WebRTC signaling & presence
│   └── routes.js             # REST API for auth, pairing, recordings, events
├── tests/
│   ├── test-backend.js       # Database, OTP, and session unit tests
│   └── test-e2e-api.js       # End-to-end API & recording workflow tests
├── data/
│   ├── sentinel.db           # SQLite database
│   └── recordings/           # Server video storage
├── package.json
├── .env.example
├── .env
└── README.md
```

---

## 🚀 Getting Started

### Prerequisites
- **Node.js**: v20 or v24+ (Node 24 recommended for native SQLite `node:sqlite`).
- **Web Browser**: Chrome, Edge, Firefox, or Safari supporting WebRTC and `MediaRecorder`.

### Installation
1. Clone or open the project folder in VS Code / Terminal:
   ```powershell
   cd "C:\Users\ARAVIND kumar\.gemini\antigravity\scratch\sentinel"
   ```

2. Install dependencies:
   ```powershell
   npm install
   # Or on Windows PowerShell:
   npm.cmd install
   ```

3. Ensure environment variables are set in `.env`:
   ```env
   PORT=3000
   HOST=0.0.0.0
   SESSION_SECRET=sentinel-dev-secret-key-change-in-production-123456789
   DATABASE_PATH=./data/sentinel.db
   RECORDINGS_DIR=./data/recordings
   STUN_SERVERS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
   ```

---

## 🏃 Running the Application

### Start the Server
```powershell
npm start
# Or for live auto-reload during development:
npm run dev
```

When the server starts, you will see output similar to:
```
========================================================
🛡️  SENTINEL SECURITY WEBCAM — SERVER STARTED
========================================================
📡 Local Viewer:        http://localhost:3000
📱 Connect Mobile/Cam:  http://192.168.1.100:3000
⚙️  Environment:         development
💾 Database:            ./data/sentinel.db
🎥 Storage:             ./data/recordings
========================================================
```

---

## 📱 Multi-Device Setup (Two Devices)

### Step 1: Open the Primary Viewer (e.g. Laptop)
1. Open Chrome or Edge and navigate to `http://localhost:3000`.
2. Sign in with your email or phone number.
   - *In development mode, the verification code is automatically displayed on screen.*
3. Navigate to **Camera Devices** or click **+ Add Camera** in the top bar.
4. A modal appears displaying a **6-digit pairing code** and a **QR Code**.

### Step 2: Open the Camera Device (e.g. Smartphone)
1. Ensure your smartphone is connected to the same Wi-Fi network.
2. Open the browser on your phone and go to `http://<YOUR-LAN-IP>:3000` (e.g. `http://192.168.1.100:3000`).
3. Click **Pair camera with code**.
4. Enter the 6-digit code shown on your laptop and choose a name (e.g. *Front Door* or *Living Room*).
5. Tap **Link & Activate Camera**.
6. Allow camera permissions when prompted.
7. Tap **Start Camera Broadcast**.

### Step 3: Stream Live Video & Record
1. Return to your laptop and navigate to **Live Cameras**.
2. Select your camera name from the dropdown.
3. The peer-to-peer WebRTC connection establishes immediately, displaying the real live video feed from your phone!
4. Click **● Record** to capture high-definition footage.
5. Click **■ Stop Recording** to save the video clip.
6. Open **Recordings** to view, scrub, download, or delete the video.

---

## 🧪 Running Automated Tests

Run the complete test suite (unit tests and end-to-end API tests):
```powershell
npm test
# Or:
npm.cmd test
```

### Tests Covered:
- SQLite schema initialization.
- Cryptographically secure OTP generation, expiration, and rate-limiting.
- User session authentication and token verification.
- WebRTC ICE servers configuration endpoint.
- Device pairing code generation and claiming.
- Video upload with Multer (`multipart/form-data`).
- HTTP 206 Partial Content video streaming (seeking support).
- Recording download and deletion.
- Motion event logging and querying.

---

## 🌐 Network & TURN Configuration

WebRTC connections operate peer-to-peer using STUN servers to discover public IP addresses. When devices reside on symmetric NATs, mobile carrier networks, or strict firewalls, direct P2P connections may require a **TURN relay server**.

To configure a TURN server, update your `.env` file:
```env
TURN_SERVER=turn:your-turn-server.com:3478
TURN_USERNAME=your-username
TURN_CREDENTIAL=your-password
```

---

## 🔒 Security & Privacy

- **User Ownership**: Video feeds and recordings belong strictly to the authenticated account.
- **No Covert Activation**: Camera streaming requires explicit user action. Camera-active indicators remain visible at all times.
- **Audio Consent**: Audio capture is disabled by default and requires explicit opt-in.
- **Resource Cleanup**: All media tracks (`track.stop()`) and peer connections are properly disposed of when streams stop.
