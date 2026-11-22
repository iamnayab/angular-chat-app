# PrivateRoom — Fullstack Angular 19 + Node.js Migration

Migrated implementation of the dedicated two-person encrypted chat application with **complete feature parity**, clean separation of concerns, and modern reactive architecture.

---

## 🏗️ Clean Modular Architecture

```
angular-node-app/
├── backend/                              # ⚙️ Dedicated Node.js Backend
│   ├── src/
│   │   ├── server.js                     # Express REST Server, SPA static host & Health APIs
│   │   ├── socket/                       # 🔌 Dedicated Separate Socket.IO Module
│   │   │   ├── index.js                  # Socket.IO lifecycle, presence, rooms & chat relay
│   │   │   └── attachmentRelay.js        # Ephemeral in-memory encrypted chunk streaming
│   │   ├── database/                     # 💾 Persistence Layer
│   │   │   └── database.js               # PostgreSQL (Auto-SSL) + JSON fallback (chat_data.json)
│   │   ├── services/                     # 📲 External Integrations
│   │   │   └── fcmService.js             # Firebase Admin high-priority ring & message push
│   │   └── utils/                        # 🛡️ Security & Validation
│   │       └── security.js               # Sliding window rate limiter & SHA-256 room auth
│   ├── .env.example
│   └── package.json
│
└── frontend/                             # 🅰️ Modern Angular 19 Client
    ├── src/
    │   ├── app/
    │   │   ├── models/
    │   │   │   └── chat.models.ts        # TypeScript interfaces (Role, Messages, Attachments)
    │   │   ├── services/
    │   │   │   ├── crypto.service.ts     # Web Crypto AES-256-GCM + PBKDF2 + SHA-256
    │   │   │   ├── socket.service.ts     # Reactive RxJS Socket.IO Client wrapper
    │   │   │   ├── storage.service.ts    # LocalStorage cache & Cache API for ephemeral blobs
    │   │   │   └── audio.service.ts      # Web Audio API ringtone chime synthesizer
    │   │   ├── app.component.ts          # Reactive Component Controller (Signals & State)
    │   │   ├── app.component.html        # Reactive HTML Template (Unlock, Role, Chat, Modals)
    │   │   └── app.component.css
    │   ├── styles.css                    # Unified Dark Cyber-Romance Theme & Animations
    │   └── index.html
    ├── angular.json
    └── package.json
```

---

## ✨ Features Implemented (Identical to Original)

1. **🔒 Secure PIN Unlock (Step 1)**:
   - 4-digit masked Room ID and Password inputs.
   - SHA-256 zero-leak verification against expected room hash.
   - PBKDF2 key derivation (310,000 iterations with SHA-256 salt) creating 256-bit AES-GCM CryptoKey directly in-browser.

2. **👥 Role Selection (Step 2)**:
   - Choice between **Harry** (`he`) and **Elira** (`she`).
   - Smooth button loader with instant spinner feedback.
   - Dynamic alignment: your messages appear on the **right**, partner's on the **left**.

3. **💬 Real-Time Encrypted Chat (Step 3)**:
   - Web Crypto AES-256-GCM client-side encryption before transmission.
   - Zero-plaintext on the server or database.
   - Real-time read receipts (`✓` Sent, `✓✓` Delivered, `✓✓ Seen` Read).
   - Real-time typing indicators with animated bouncing dots.
   - Live presence indicator dot (`● Harry/Elira Online ❤️` / `● Harry/Elira Offline`).
   - Relative last seen indicator (e.g. `just now`, `5m ago`, `today at 03:30 PM`).

4. **🔔 Manual Ring Feature**:
   - Web button with 15s rate-limit protection.
   - Web Audio API audible ring chime.
   - Companion Android FCM high-priority ring dispatch.

5. **📎 Ephemeral Encrypted Attachments**:
   - Support for pictures, videos, audio, documents, PDFs, archives (up to 25 MB).
   - File attachment preview modal before sending.
   - Drag-and-drop on the chat panel + clipboard paste (`Ctrl+V` screenshot upload).
   - 64 KB chunk streaming via WebSockets with real-time percentage progress bar.
   - **STRICT PRIVACY**: Ephemeral in-memory RAM buffer on server with 5-min TTL. Server frees memory as soon as recipient acknowledges receipt. Zero disk storage, zero database records.
   - Fullscreen Lightbox image viewer with "📥 Save to Device" button.

6. **🗑️ Clear Room History**:
   - Permanently deletes message history from cloud database, local storage cache, and ephemeral RAM.

7. **⚡ Robust Resilience**:
   - 10-second disconnect grace period to avoid mobile blip flickering.
   - Automatic seamless socket reconnection.

---

## 🚀 How to Run

### Option 1: Fullstack Production Mode (Recommended)
Builds the Angular frontend and serves both REST API, Socket.IO, and the Angular UI from the Node.js server on `http://localhost:3000`:

```bash
# 1. From angular-node-app root:
npm run build:client

# 2. Start the unified server:
npm start
```
Open **http://localhost:3000** in your browser.

---

### Option 2: Independent Development Mode
Run Angular CLI dev server with hot reload alongside the Node.js backend:

**Terminal 1 — Backend (Port 3000):**
```bash
cd backend
npm run dev
```

**Terminal 2 — Angular Client (Port 4200):**
```bash
cd frontend
npm start
```
Open **http://localhost:4200** in your browser. Angular automatically connects to the backend at `http://localhost:3000`.
