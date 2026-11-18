<div align="center">

# ☁️ Cloudyte

### **One Unified Cloud OS for Google Drive, Microsoft OneDrive & Telegram Drive**
*Stream, transfer, back up, and zero-knowledge encrypt your files across every cloud — from a sleek web dashboard, REST API, or Telegram Bot.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-Express-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)
[![MongoDB](https://img.shields.io/badge/MongoDB-Atlas_Ready-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![Encryption](https://img.shields.io/badge/E2EE-AES--256--GCM-8B5CF6?style=for-the-badge&logo=letsencrypt&logoColor=white)](#-zero-knowledge-end-to-end-encryption-cyte1)
[![Tests](https://img.shields.io/badge/Tests-45%2F45_Passing-10B981?style=for-the-badge)](#%EF%B8%8F-testing--verification)

---

[**✨ Features**](#-why-cloudyte) •
[**🏗️ Architecture**](#%EF%B8%8F-system-architecture) •
[**🔐 Security & E2EE**](#-security--zero-knowledge-e2ee) •
[**🚀 Quick Start**](#-quick-start) •
[**🔑 OAuth & Bot Setup**](#-provider--bot-setup-guide) •
[**📡 REST API**](./API_DOCUMENTATION.md)

</div>

---

## 🌟 Why Cloudyte?

Juggling multiple Google accounts, OneDrive storage limits, and scattered Telegram channels is painful. **Cloudyte** turns all of your cloud accounts into a single, blazing-fast, self-hostable storage hub:

| Capability | Google Drive | Microsoft OneDrive | Telegram Drive (`tgdrive`) |
| :--- | :---: | :---: | :---: |
| **Virtual Folders & Instant Rename** | ✅ Native | ✅ Native | ✅ Hybrid MongoDB VFS |
| **2 GB+ Resumable Chunked Uploads** | ✅ Resumable URI | ✅ Upload Session | ✅ MTProto Streamed |
| **HTTP `Range` Video / Audio Streaming** | ✅ `206 Partial` | ✅ `206 Partial` | ✅ Direct GramJS Stream |
| **Cross-Cloud Move & Copy** | ✅ Any-to-Any | ✅ Any-to-Any | ✅ Any-to-Any |
| **Soft Trash, Restore & Empty Trash** | ✅ Native Trash | ✅ Recycle Bin Sync | ✅ Virtual Trash + Message Revoke |
| **Zero-Knowledge E2EE (`CYTE1`)** | ✅ Supported | ✅ Supported | ✅ Supported |
| **7-Point Validated Public Shares** | ✅ PIN / Expiry / Cap | ✅ PIN / Expiry / Cap | ✅ PIN / Expiry / Cap |

> 💡 **Plug-and-Play Providers:** You don't need to configure all 3 providers! Run Cloudyte with **only Telegram + OneDrive**, **only Google Drive**, or **all three together** — the server automatically adapts based on your `.env`.

---

## 🔥 Core Highlights

### 1. 🚀 Zero-Double-Write Resumable Uploads
- **Direct Binary Streaming (`application/octet-stream`)**: Chunks stream straight from the network socket into staging storage while computing SHA-256 on the fly — zero extra Multer temp-file copies.
- **Pause, Resume & Auto-Recovery**: Interrupted uploads resume from the exact byte offset (`X-Chunk-Offset`) even after a server restart.
- **End-to-End Integrity & Bomb Shield**: Per-chunk (`X-Chunk-Sha256`) and full-file SHA-256 verification, magic-byte MIME sniffing, and ZIP central-directory compression ratio checks to block archive bombs.

### 2. 🔄 Zero-Data-Loss Cross-Cloud Transfers & Backups
- **Move & Copy Across Any Cloud**: Transfer files directly between Telegram, Google Drive, and OneDrive in the background (`202 Accepted` with real-time SSE progress `/api/jobs/:jobId/stream`).
- **Strict Move Safety Fence**: When moving a file across clouds, Cloudyte **never** deletes the source file until:
  1. The destination provider returns a verified file ID (`id` / `_id` / `messageId`).
  2. The destination byte size matches the source (`verifiedBytes === sourceSize`).
  3. `sourceDeleteApproved: true` is committed in `transfer_manifests` and the job has not been cancelled.
- **Conflict-Safe Batch Restore**: Restoring a backup never overwrites your existing files silently — conflicting names are automatically saved as `<filename> (conflict copy).<ext>`.

### 3. 🔐 Security & Zero-Knowledge E2EE
- **Client-Side `CYTE1` Encryption (`AES-256-GCM`)**: Encrypt file contents and filenames in the browser or mobile client before a single byte touches the server. The server only sees opaque `cyte_<id>.cyte1` blobs and optionally stores an opaque `PBKDF2-HMAC-SHA256` wrapped key backup.
- **Personal Access Tokens (PATs)**: Issue revocable tokens (`pat_...`) with granular scopes (`read`, `write`, `delete`, `share`, `admin`) and lock a token down to a **single Cloud Account (`accountId`)** or a **single Subfolder (`rootFolderId`)**.
- **Brute-Force Lockout & Device Tracking**: Progressive login delays after 2 failed tries, automatic 15-minute lockout after 5 failed attempts, and full session management with **Device Name, User-Agent, and IP History**.
- **One-Time Download Tickets (`dlt_...`)**: Stream videos or trigger browser downloads without ever exposing your session token in URL query strings.
- **7-Point Public Share Validation**: Every `/s/:shareId` link verifies live that the share exists, isn't revoked, hasn't expired, is under `maxDownloads`, matches any optional **PIN code**, belongs to an active account, and that the file hasn't been moved to Trash.

### 4. 🤖 Built-in Telegram Bot + Unlimited "TG Drive"
- Turn any private Telegram channel into an **unlimited cloud drive** backed by a MongoDB virtual folder hierarchy (`tg_files` + `tg_folders`).
- Forward or send any file to the Cloudyte Telegram Bot to back it up directly to your default cloud drive, search across accounts inline, or generate instant share links.

---

## 🏗️ System Architecture

```text
                       ┌──────────────────────────────────────────┐
                       │     Web Dashboard (React 19 + Vite)      │
                       │   Mobile App / CLI / Telegram Bot User   │
                       └────────────────────┬─────────────────────┘
                                            │ HTTPS / Range / SSE
                                            ▼
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                            Cloudyte Backend (Node.js + Express)                       │
│                                                                                       │
│  ┌──────────────────────┐   ┌────────────────────────┐   ┌─────────────────────────┐  │
│  │   Auth & Security    │   │   Upload / Download    │   │   Multi-Queue Worker    │  │
│  │  • Sliding Sessions  │   │  • Zero-Double-Write   │   │  • Cross-Cloud Move/Copy│  │
│  │  • Scoped PAT Tokens │   │  • SHA-256 & Zip Guard │   │  • Batch Backup/Restore │  │
│  │  • Login Lockout     │   │  • Range & HEAD Stream │   │  • Lease & Heartbeats   │  │
│  │  • Confinement Guard │   │  • 1-Time DL Tickets   │   │  • Dead-Letter Recovery │  │
│  └──────────┬───────────┘   └───────────┬────────────┘   └────────────┬────────────┘  │
└─────────────┼───────────────────────────┼─────────────────────────────┼───────────────┘
              │                           │                             │
              ▼                           ▼                             ▼
   ┌────────────────────┐      ┌────────────────────┐        ┌────────────────────┐
   │   MongoDB Atlas    │      │ Google Drive API   │        │  Telegram MTProto  │
   │  • Virtual FS      │      │ Microsoft Graph    │        │  (GramJS + Telegraf│
   │  • Jobs & Manifests│      │ (OAuth2 + Retries  │        │   2GB+ Channels)   │
   │  • 90d Audit Logs  │      │  + Circuit Breaker)│        │                    │
   └────────────────────┘      └────────────────────┘        └────────────────────┘
```

### 📂 Repository Layout

```text
├── frontend/                  # React 19 + Tailwind CSS + Lucide UI
│   ├── App.tsx                # Multi-drive file explorer, upload manager, E2EE & admin panel
│   └── main.tsx               # SPA entry point
├── backend/                   # Modular Production-Hardened Backend
│   ├── core.ts                # Config, Mongo pools/indexes, caches, auth, PATs, lockout & audit logs
│   ├── protocol.ts            # Pure helpers, CYTE1 E2EE validators, magic-byte sniffing, RFC headers
│   ├── provider.ts            # Google Drive, OneDrive & Telegram adapters, retries, Sharp thumbnails
│   ├── jobs.ts                # Multi-queue worker, cross-account transfers, batch backups & restore
│   ├── telegram.ts            # Telegraf bot commands & GramJS MTProto channel streaming engine
│   ├── server.ts              # Express HTTP routes, middleware pipeline & graceful shutdown
│   └── server.test.ts         # 45-test end-to-end reliability, security & E2EE test suite
├── server.ts                  # Root entry point (re-exports backend/server.ts)
└── API_DOCUMENTATION.md       # Full REST API specification for web & mobile clients
```

---

## 🚀 Quick Start

### Prerequisites
- **Node.js** `v20+` (or **Bun**)
- **MongoDB** (local instance or free [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) cluster)

### 1. Clone & Install
```bash
git clone <your-repo-url> cloudyte
cd cloudyte
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```
Fill in your minimum required variables in `.env`:
```env
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/cloudyte
APP_URL=http://localhost:3000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=supersecretpassword
```
*(Add Google, Microsoft OneDrive, or Telegram credentials as needed — see below).*

### 3. Run in Development
```bash
npm run dev
```
Open **`http://localhost:3000`** in your browser and sign in with your `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

---

## 🔑 Provider & Bot Setup Guide

You can enable **any combination** of the following storage providers:

<details open>
<summary><b>☁️ 1. Microsoft OneDrive Setup (Azure Portal)</b></summary>

1. Open [Azure Portal — App Registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) and click **New registration**.
2. Set **Supported account types** to *Accounts in any organizational directory and personal Microsoft accounts*.
3. Under **Redirect URI (Web)**, add:
   ```text
   https://your-domain.com/auth/microsoft/callback
   ```
   *(or `http://localhost:3000/auth/microsoft/callback` for local testing).*
4. Copy the **Application (client) ID** → `MICROSOFT_CLIENT_ID`.
5. Go to **Certificates & secrets** → **New client secret** and copy **Value** → `MICROSOFT_CLIENT_SECRET`.
6. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**:
   - `Files.ReadWrite.All`
   - `User.Read`
   - `offline_access`
</details>

<details>
<summary><b>🌐 2. Google Drive Setup (Google Cloud Console)</b></summary>

1. Open the [Google Cloud Console](https://console.cloud.google.com/), create a project, and enable the **Google Drive API**.
2. Configure the **OAuth Consent Screen** and add scopes `.../auth/drive` and `.../auth/userinfo.email`.
3. Go to **Credentials** → **Create Credentials** → **OAuth client ID** (Web application).
4. Under **Authorized redirect URIs**, add:
   ```text
   https://your-domain.com/auth/google/callback
   ```
5. Copy the Client ID and Secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
</details>

<details>
<summary><b>🤖 3. Telegram Bot & "TG Drive" Setup</b></summary>

1. Message [@BotFather](https://t.me/botfather) on Telegram with `/newbot` and copy the token → `TELEGRAM_BOT_TOKEN`.
2. Visit [my.telegram.org](https://my.telegram.org/auth) → **API development tools** to get your `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`.
3. To use a Telegram channel as an unlimited cloud drive:
   - Create a **Private Telegram Channel**.
   - Add your bot to the channel as an **Administrator** (with *Post Messages* & *Delete Messages* permissions).
   - Forward any message from the channel or copy the Channel ID (`-100xxxxxxxxxx`) and link it in the Cloudyte Dashboard under **Add Telegram Drive**.
</details>

---

## ⚙️ Full Environment Variables Reference

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `MONGODB_URI` | ✅ | — | MongoDB connection string |
| `APP_URL` | ✅ | `http://localhost:3000` | Public base URL used for OAuth callbacks & share links |
| `ADMIN_USERNAME` | ✅ | — | Root administrator username |
| `ADMIN_PASSWORD` | ✅ | — | Root administrator password |
| `MICROSOFT_CLIENT_ID` | Optional | — | Azure App Client ID for OneDrive linking |
| `MICROSOFT_CLIENT_SECRET` | Optional | — | Azure App Client Secret for OneDrive linking |
| `GOOGLE_CLIENT_ID` | Optional | — | Google Cloud OAuth Client ID for Google Drive |
| `GOOGLE_CLIENT_SECRET` | Optional | — | Google Cloud OAuth Client Secret for Google Drive |
| `TELEGRAM_BOT_TOKEN` | Optional | — | Bot token from `@BotFather` |
| `TELEGRAM_API_ID` | Optional | — | Telegram MTProto API ID from `my.telegram.org` |
| `TELEGRAM_API_HASH` | Optional | — | Telegram MTProto API Hash from `my.telegram.org` |
| `MEDIA_SIGNING_SECRET` | Optional | Auto-derived | HMAC secret for signing `/api/media-link` URLs |
| `ALLOWED_ORIGINS` | Optional | `*` | Comma-separated allowed Origins for CSRF/CORS protection |
| `LOGIN_MAX_ATTEMPTS` | Optional | `5` | Failed login attempts before temporary lockout |
| `LOGIN_WINDOW_MS` | Optional | `900000` (15m) | Window for counting failed login attempts |
| `LOGIN_LOCKOUT_MS` | Optional | `900000` (15m) | Lockout duration after exceeding `LOGIN_MAX_ATTEMPTS` |
| `TEMP_DIR` | Optional | `/tmp/cloudyte-temp` | Dedicated staging directory for uploads & transfers |
| `THUMB_DIR` | Optional | `/tmp/cloudyte-thumbs` | Disk cache directory for generated thumbnails |
| `MIN_TEMP_FREE_BYTES` | Optional | `536870912` (512MB) | Minimum free disk space required to accept new uploads |
| `MAX_CONCURRENT_JOBS` | Optional | `3` | Parallel background worker concurrency |
| `MAX_GLOBAL_CONCURRENT_UPLOADS` | Optional | `10` | Server-wide concurrent upload cap |
| `MAX_CONCURRENT_UPLOADS_PER_USER`| Optional | `3` | Per-user concurrent upload cap |
| `MAX_DAILY_UPLOAD_BYTES_PER_USER`| Optional | `10737418240` (10GB)| Per-user daily upload quota |
| `MAX_CONCURRENT_DOWNLOADS_PER_USER`| Optional | `6` | Per-user concurrent download stream cap |
| `DOWNLOAD_IDLE_TIMEOUT_MS` | Optional | `60000` (60s) | Timeout for stalled download streams |
| `PROVIDER_API_TIMEOUT_MS` | Optional | `30000` (30s) | Timeout for upstream Google / OneDrive / Telegram calls |

---

## 🧪 Testing & Verification

Cloudyte ships with a comprehensive **45-test integration suite** (`backend/server.test.ts`) that runs against an in-memory mock MongoDB & provider harness (zero external credentials required):

```bash
# Run all 45 integration tests (Auth, PATs, Resumable Uploads, E2EE, Transfers, Backups, Trash, Shares)
npm test

# Run TypeScript type-checking
npm run lint

# Build the production frontend bundle
npm run build
```

---

## 🚢 Production Deployment

### Option A: Node.js + PM2
```bash
npm ci
npm run build

# Start with PM2
pm2 start "npm start" --name cloudyte
pm2 save
pm2 startup
```

### Option B: Docker
```bash
docker build -t cloudyte .
docker run -d \
  --name cloudyte \
  -p 3000:3000 \
  --env-file .env \
  --restart unless-stopped \
  cloudyte
```

### Health & Observability Endpoints in Production
- **`GET /healthz`** — Liveness probe (`200 OK` with uptime).
- **`GET /readyz`** — Readiness probe (`200 OK` when MongoDB is connected & temp disk headroom is healthy).
- **`GET /api/jobs/health`** — Multi-queue worker heartbeat and queue depth status.
- **`GET /api/admin/metrics`** — CPU, RAM, event-loop lag, disk usage, cache hit/miss rates, and provider latency/error telemetry.
- **`GET /api/admin/audit-logs`** — Structured 90-day security & operational audit trail.

---

## 📡 Complete API Documentation

Building a custom Android/iOS client, CLI tool, or automation script?
👉 Check out the full [**`API_DOCUMENTATION.md`**](./API_DOCUMENTATION.md) for request/response schemas, OAuth Custom Tab flows, `CYTE1` encryption specs, and Personal Access Token usage.

---

<div align="center">

**❤️ Built for Speed, Reliability & Zero-Knowledge Privacy**
Created by **Arshman**

</div>