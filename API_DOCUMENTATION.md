# Cloudyte API Documentation

This document provides a comprehensive, production-ready guide to all backend REST API endpoints and OAuth workflows in Cloudyte.
You can use this specification to integrate custom Android / iOS apps, desktop clients, command-line tools, or custom web frontends.

---

## 1. Architecture & Base URL

All API routes are served under the root URL of your deployed Cloudyte server.

- **Base URL Example:** `https://your-domain.com` (or `http://localhost:3000` in local development)
- **Content Type:** JSON (`application/json`) is expected for POST/PATCH bodies, except for `/api/upload/:accountId` which requires `multipart/form-data`.
- **Media Streaming:** Video, audio, and large file download endpoints support HTTP `Range` requests (`206 Partial Content`) for native media players (such as Android ExoPlayer / AVPlayer).

---

## 2. Authentication & Access Tokens

Most endpoints require user authentication. Cloudyte supports two bearer credential types in the standard HTTP `Authorization` header:

1. **Session Token** (returned by `POST /api/login`):
   ```http
   Authorization: Bearer <session_token>
   ```
2. **Personal Access Token (PAT)** (created via `POST /api/tokens` with fine-grained scopes and optional account/folder confinement):
   ```http
   Authorization: Bearer pat_<token>
   ```

*Alternative Query Parameter & One-Time Download Tickets:*
- For native media players or WebViews that cannot set custom headers, prefer issuing a short-lived or single-use **Download Ticket** (`POST /api/download-tickets` -> `GET /api/download/ticket/:ticket`) so bearer tokens never appear in URLs or logs.
- Legacy query-parameter tokens (`GET /api/download/:accountId/:fileId?token=<session_token>`) and signed media URLs (`GET /api/media-link/:accountId/:fileId`) also remain supported.

*Origin Protection:*
- When `ALLOWED_ORIGINS` (comma-separated origin list) is configured, state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) carrying an `Origin` header are validated against the allowlist (`403 FORBIDDEN` on mismatch).

*Admin Basic Auth:*
Admin endpoints also accept HTTP Basic Auth using the root credentials:
```http
Authorization: Basic <base64(admin_username:admin_password)>
```

---

## 3. Public & Auth Endpoints

> **Rate Limiting:** `/api/login` and `/api/register` are rate-limited to 10 requests per minute per IP address. Upload requests are limited to 30 per 15 minutes per IP by default and can be changed with `UPLOAD_REQUESTS_PER_WINDOW`. Exceeding a limit returns HTTP `429` with an `error` message and machine-readable `code: "RATE_LIMITED"`.

New server-level, upload, and rate-limit errors retain the existing string `error` field for compatibility and also include a stable `code` and `requestId` where available. Uploads are rejected with `507 INSUFFICIENT_STORAGE` when the server temporary directory does not have the configured free-space reserve. Provider uploads and cross-account transfers are bounded by per-account concurrency limits to prevent upstream overload.

### 3.0 Standard Error Response Format
Every error response across all routes follows a consistent JSON envelope:
```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE",
  "requestId": "e559cb22-a7b2-4b5c-b2ed-7425a501c252",
  "retryable": true
}
```
- **Standard Error Codes:** `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `PROVIDER_ERROR`, `UPLOAD_FAILED`, `TRANSFER_FAILED`, `INSUFFICIENT_STORAGE`, `INTERNAL_ERROR` (plus domain-specific E2EE/session codes listed in Section 11.7).
- **Request Tracing:** Every HTTP response includes an `X-Request-Id` header matching `requestId`. Clients may also supply their own `X-Request-Id` header for end-to-end correlation.

### 3.1 Health Check
Liveness and uptime monitor.
- **Method & Route:** `GET /healthz`
- **Auth Required:** No
- **Response (200 OK):**
  ```json
  {
    "ok": true,
    "uptimeSec": 3600
  }
  ```

### 3.1.1 Readiness Check
Deployment readiness monitor. Returns `200` only when the server is not shutting down, MongoDB is connected, and temporary disk headroom (`MIN_TEMP_FREE_BYTES`) is available; otherwise returns `503`.
- **Method & Route:** `GET /readyz`
- **Auth Required:** No
- **Response (200 OK):**
  ```json
  {
    "ok": true,
    "status": "ready",
    "mongo": true,
    "diskHeadroom": true
  }
  ```

For large cross-account transfers and multi-file backups, clients can opt into durable background processing (`?async=true` on `/api/files/move` and `/api/files/copy`, or `POST /api/backups/batch`). The server returns `202 Accepted` and a job ID; jobs are leased, heartbeated, and persisted in MongoDB.

### 3.2 Get Public Settings
Returns the global registration policy.
- **Method & Route:** `GET /api/public/settings`
- **Auth Required:** No
- **Response:**
  ```json
  {
    "registrationEnabled": true,
    "webRegistrationEnabled": true,
    "botRegistrationEnabled": true
  }
  ```

### 3.3 User Registration
Register a new user account if public registration is enabled. Subject to rate limits (10 req/min).
- **Method & Route:** `POST /api/register`
- **Auth Required:** No
- **Request Body (JSON):**
  ```json
  {
    "username": "alice",
    "password": "strongpassword123"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true
  }
  ```
- **Errors:** `400 Bad Request` (missing fields, username taken, registration disabled), `429 Too Many Requests`.

### 3.4 User Login (with Progressive Throttling & Lockout)
Authenticate with username and password to receive a persistent session token.
- **Method & Route:** `POST /api/login`
- **Auth Required:** No
- **Brute-Force Protection:**
  - Tracked independently per username and per client IP (`LOGIN_WINDOW_MS`, default 15 minutes).
  - Applies a progressive delay (`250ms`, `500ms`, `1000ms`, up to `2000ms`) starting after the 2nd failed attempt.
  - Locks out the username/IP for `LOGIN_LOCKOUT_MS` (default 15 minutes) after `LOGIN_MAX_ATTEMPTS` (default 5) failed attempts, returning `429 RATE_LIMITED` with a `Retry-After` header.
- **Request Body (JSON):**
  ```json
  {
    "username": "alice",
    "password": "strongpassword123"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "token": "4f8a9e2b1c7d...",
    "username": "alice",
    "isAdmin": false
  }
  ```
- **Errors:** `401 Unauthorized` (invalid credentials or deactivated account), `429 Too Many Requests` (rate limit or login lockout active).

### 3.5 Logout
Revokes the current session (`revokedAt`) in MongoDB and evicts it from the in-memory auth cache.
- **Method & Route:** `POST /api/logout`
- **Auth Required:** Yes
- **Response (200 OK):**
  ```json
  {
    "success": true
  }
  ```

### 3.6 Active Device Sessions, IP History & Sliding Expiry
List or revoke active login sessions for the authenticated user (raw tokens are never returned).
- **Sliding Session Expiry & Device Tracking:** Sessions default to a 30-day TTL (`expiresAt`), slide forward automatically on activity, and track `deviceName`, `userAgent`, current `ip`, and recent `ipHistory` (up to 10 distinct IPs).
- **List Sessions:** `GET /api/sessions`
  - **Response (200 OK):** Array of `{ sessionId, deviceName, userAgent, ip, ipHistory, createdAt, lastActiveAt, lastUsedAt, expiresAt, isCurrent }`.
- **Revoke Session:** `DELETE /api/sessions/:sessionId`
  - Marks the session as revoked (`revokedAt`) and immediately invalidates it (`200 OK`: `{ "success": true }`).

### 3.7 Personal Access Tokens (PATs) with Scopes & Confinement
Issue scoped, revocable API tokens for CLI tools, automation scripts, or third-party integrations without exposing a full user session.
- **Supported Scopes:**
  - `read`: Read-only access (`GET` / `HEAD` endpoints such as file listings, downloads, thumbnails, storage summary).
  - `write`: Upload files, create folders, rename, copy, move, and manage upload sessions.
  - `delete`: Soft-delete files, permanently delete files, and empty trash.
  - `share`: Create or revoke public share links (`/api/share*`).
  - `admin`: Access admin endpoints (only effective if the owning user is an admin).
- **Account & Folder Confinement:**
  - If `accountId` is set on the token, requests targeting any other `accountId` are rejected with `403 FORBIDDEN`.
  - If `rootFolderId` is set on the token, requests targeting folders outside that root folder path are rejected with `403 FORBIDDEN`.
- **List Active Tokens:** `GET /api/tokens`
  - **Response (200 OK):** Array of `{ tokenId, name, tokenPreview, scopes, accountId, rootFolderId, createdAt, lastUsedAt, expiresAt }`.
- **Create Token:** `POST /api/tokens`
  - **Request Body (JSON):**
    ```json
    {
      "name": "Backup Script Token",
      "scopes": ["read", "write"],
      "accountId": "65d8a1f2e4b0111111111111",
      "rootFolderId": "backups/2026",
      "expiresInDays": 30
    }
    ```
  - **Response (201 Created):**
    ```json
    {
      "tokenId": "448wphlmrz4k",
      "name": "Backup Script Token",
      "token": "pat_9f8e7d6c5b4a...",
      "scopes": ["read", "write"],
      "accountId": "65d8a1f2e4b0111111111111",
      "rootFolderId": "backups/2026",
      "createdAt": "2026-11-18T09:00:00.000Z",
      "expiresAt": "2026-12-18T09:00:00.000Z"
    }
    ```
- **Revoke Token:** `DELETE /api/tokens/:tokenId`
  - Immediately revokes the token (`200 OK`: `{ "success": true }`).

---

## 4. User Profile & Settings

### 4.1 Get Current User Profile
Retrieves the logged-in user's profile and preferences.
- **Method & Route:** `GET /api/me`
- **Auth Required:** Yes
- **Response (200 OK):**
  ```json
  {
    "authenticated": true,
    "username": "alice",
    "isAdmin": false,
    "settings": {
      "username": "alice",
      "backupEnabled": true,
      "backupAccId": "65d8a1f2e4b0...",
      "isDefaultAccId": "65d8a1f2e4b0..."
    }
  }
  ```

### 4.2 Update User Settings
Configures default storage drive and automated backup drive preferences.
- **Method & Route:** `POST /api/user/settings`
- **Auth Required:** Yes
- **Request Body (JSON):**
  ```json
  {
    "backupEnabled": true,
    "backupAccId": "65d8a1f2e4b0...",
    "isDefaultAccId": "65d8a1f2e4b0..."
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true
  }
  ```

---

## 5. Storage Accounts & Drive Linking (Google Drive, OneDrive, Telegram)

Cloudyte supports multi-cloud storage drives linked to a user profile.

### 5.1 List Linked Accounts (Drives)
Fetches all drives connected to the current user (Google Drive, OneDrive, Telegram Drive), along with real-time storage quota and usage.
- **Method & Route:** `GET /api/accounts`
- **Auth Required:** Yes
- **Query Params:** `userId` *(Optional, Admin only - view drives of a specific user)*
- **Response (200 OK):**
  ```json
  [
    {
      "id": "65d8a1f2e4b0111111111111",
      "name": "My Telegram Drive",
      "email": "Channel: -1001987654321",
      "accountType": "tgdrive",
      "usage": "2.40 GB",
      "total": "∞",
      "percentage": 0,
      "fileCount": 42,
      "isDefault": true
    },
    {
      "id": "65d8a1f2e4b0222222222222",
      "name": "Alice Google Drive",
      "email": "alice@gmail.com",
      "accountType": "google",
      "usage": "11.20 GB",
      "total": "15.00 GB",
      "percentage": 74.6,
      "fileCount": 180,
      "isDefault": false
    },
    {
      "id": "65d8a1f2e4b0333333333333",
      "name": "Alice OneDrive",
      "email": "alice@outlook.com",
      "accountType": "onedrive",
      "usage": "1.80 GB",
      "total": "5.00 GB",
      "percentage": 36.0,
      "fileCount": 55,
      "isDefault": false
    }
  ]
  ```

### 5.2 Get Storage Summary & Category Breakdown
Returns storage usage, quota, file count, and per-category byte breakdown for a specific linked account.
- **Method & Route:** `GET /api/storage/summary?accountId=<id>`
- **Auth Required:** Yes
- **Query Parameters:**
  - `accountId` *(Required)*: The ID of the linked storage account.
- **Caching:**
  - Responses are cached in `NodeCache` for 60 seconds per account and automatically invalidated on file upload, delete, move, and copy.
  - For Google Drive and OneDrive, reuses the 5-minute cached quota fields (`quotaUsage`, `quotaLimit`, `quotaCachedAt`) from `/api/accounts` so the upstream provider is not queried on every request.
- **Response (200 OK — Telegram Drive `tgdrive`):**
  Aggregates `tg_files` with a single MongoDB `$group` stage on `size` bucketed by MIME type and file extension (`image/*`, `video/*`, `audio/*`, pdf/doc/xls/ppt/text types, zip/rar/7z/tar/gz, and everything else):
  ```json
  {
    "accountId": "65d8a1f2e4b0111111111111",
    "accountType": "tgdrive",
    "usedBytes": 2576980377,
    "totalBytes": null,
    "fileCount": 42,
    "categories": {
      "images": 524288000,
      "videos": 1572864000,
      "audio": 104857600,
      "documents": 262144000,
      "archives": 83886080,
      "other": 28940697
    }
  }
  ```
- **Response (200 OK — Google Drive `google` / OneDrive `onedrive`):**
  ```json
  {
    "accountId": "65d8a1f2e4b0222222222222",
    "accountType": "google",
    "usedBytes": 12025908428,
    "totalBytes": 16106127360,
    "fileCount": null,
    "categories": null
  }
  ```

### 5.3 Delete / Unlink Account
Disconnects a storage provider from the user's account.
- **Method & Route:** `DELETE /api/accounts/:id`
- **Auth Required:** Yes
- **Response (200 OK):** `{ "success": true }`

---

### 5.3 Google Drive & OneDrive Linking Workflows (OAuth & Base URL Guide)

When building an Android app or client that needs to link Google Drive or Microsoft OneDrive, the flow uses the server's **Base URL** for OAuth authorization and callback handling.

#### How the OAuth Linking Architecture Works:
1. **Server Base URL (`APP_URL`):**
   The Cloudyte server is configured with an `APP_URL` (for example `https://cloudyte.example.com`). The OAuth callback URLs are registered as:
   - Google: `${APP_URL}/auth/google/callback`
   - Microsoft OneDrive: `${APP_URL}/auth/microsoft/callback` (or configured via `MICROSOFT_REDIRECT_URI`)
2. **Session State Handshake:**
   When the client requests an authorization URL, the server creates a random, short-lived, one-time OAuth `state` record in MongoDB associated with the authenticated user and provider. The raw session token is not sent to Google or Microsoft. When the provider redirects back to the callback URL, the server consumes and validates the state record, attributes the tokens to the correct user ID, and completes the link.

#### 5.3.1 Google Drive OAuth Linking Endpoint
Generates the Google OAuth consent URL for the authenticated user.
- **Method & Route:** `GET /api/auth/drive-link`
- **Auth Required:** Yes (`Authorization: Bearer <session_token>`)
- **Response (200 OK):**
  ```json
  {
    "url": "https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&scope=...&prompt=consent&response_type=code&client_id=...&redirect_uri=https%3A%2F%2Fyour-server.com%2Fauth%2Fgoogle%2Fcallback&state=<one-time-state>"
  }
  ```

#### 5.3.2 OneDrive OAuth Linking Endpoint
Generates the Microsoft OneDrive OAuth consent URL for the authenticated user.
- **Method & Route:** `GET /api/auth/onedrive-link`
- **Auth Required:** Yes (`Authorization: Bearer <session_token>`)
- **Response (200 OK):**
  ```json
  {
    "url": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=...&response_type=code&redirect_uri=https%3A%2F%2Fyour-server.com%2Fauth%2Fmicrosoft%2Fcallback&response_mode=query&scope=files.readwrite.all+User.Read+offline_access&state=<one-time-state>&prompt=select_account"
  }
  ```

#### 5.3.3 Android / Native Client Integration Steps for OAuth:
1. **Call the Link Endpoint:** In your native app, make an authorized HTTP GET call to `GET /api/auth/drive-link` or `GET /api/auth/onedrive-link`.
2. **Open in Custom Tab / WebView:**
   - Launch the returned `url` in **Android Chrome Custom Tabs** or an in-app browser with cookies enabled.
3. **Consent & Callback Execution:**
   - The user signs in and accepts permissions on Google / Microsoft.
   - Google / Microsoft redirects to `${BASE_URL}/auth/google/callback?code=...&state=...` (or `${BASE_URL}/auth/microsoft/callback`).
   - The Cloudyte server automatically exchanges the authorization code for refresh tokens, saves the linked account to the database, and responds with a success HTML page that calls `window.close()`.
4. **Refresh Accounts List in App:**
   - On returning to the app (e.g. `onResume` / Custom Tab closed), call `GET /api/accounts` to refresh the user's linked drives.

#### 5.3.4 Short-Lived Media Links
Authenticated clients can request a signed media URL when a media component cannot attach an `Authorization` header:

- **Method & Route:** `GET /api/media-link/:accountId/:fileId`
- **Auth Required:** Yes
- **Lifetime:** 10 minutes
- **Response:** `{ "url": "...", "expiresAt": 1770000000000 }`

The returned URL is bound to the exact account and file. The existing bearer-token download path remains supported for compatibility.

#### 5.3.5 Direct Telegram OAuth Route (Optional)
Used when initiating linking from Telegram Bot interactions:
- **Route:** `GET /auth/link?tgId=<telegram_user_id>`

---

### 5.4 Register Telegram Storage Drive
Links a private or public Telegram channel as an unlimited cloud storage drive.
*(Note: The Cloudyte bot must be added as an Administrator with post/upload permissions in the Telegram channel).*
- **Method & Route:** `POST /api/tgdrive/register`
- **Auth Required:** Yes
- **Request Body (JSON):**
  ```json
  {
    "channelId": "-1001987654321",
    "driveName": "My Telegram Cloud"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "id": "65d8a1f2e4b0111111111111",
    "channelId": "-1001987654321",
    "name": "My Telegram Cloud"
  }
  ```
- **Errors:** `400 Bad Request` (missing channel ID or bot lacks admin permissions in channel).

---

### 5.5 Telegram Drive Database & Virtual Filesystem Architecture

Telegram channels natively store media as flat message streams without directories or folder structures. Cloudyte solves this by maintaining a **hybrid storage engine**:
1. **Raw File Binaries:** Stored directly in the linked Telegram channel as message attachments (providing virtually unlimited, free cloud storage).
2. **Virtual Filesystem in MongoDB:** All directories, folder hierarchies, custom file names, MIME types, and share IDs are indexed and managed in MongoDB collections:
   - **`tg_files` collection:** Stores each file's metadata (`messageId`, `accountId`, `name`, `size`, `mimeType`, `folder`, `shareId`, `date`).
   - **`tg_folders` collection:** Stores virtual directory paths (`accountId`, `name`, `path`, `createdAt`).

#### Telegram Drive Database Schema:
```typescript
// tg_files Document
interface TgFileDoc {
  _id: ObjectId;          // Unique file ID (used in /api/files/:fileId and /api/download/:accId/:fileId)
  userId?: string;        // Owner user ID
  accountId: ObjectId;    // Linked tgdrive account _id
  messageId: number;      // Telegram message ID in the channel
  shareId: string;        // Public share code (for /s/:shareId)
  name: string;           // File display name (e.g. "presentation.pdf")
  size: number;           // File size in bytes
  mimeType: string;       // Detected MIME type
  folder: string;         // Virtual folder path (e.g. "" for root, "documents/work" for nested)
  caption?: string;       // Optional Telegram message caption
  date: number;           // Unix timestamp (seconds)
}

// tg_folders Document
interface TgFolderDoc {
  _id: ObjectId;
  userId?: string;
  accountId: ObjectId;    // Linked tgdrive account _id
  name: string;           // Folder name (e.g. "work")
  path: string;           // Full folder path (e.g. "documents/work")
  createdAt: number;      // Unix timestamp (seconds)
}
```

#### How Folder Paths Work in Telegram Drive:
- **Root Directory:** Indicated by `""` (empty string) or `"root"`.
- **Subdirectories:** Indicated by relative slash paths, e.g., `"photos"` or `"photos/2026"`.
- **Folder IDs in `GET /api/files`:** Folders in Telegram Drive are returned with IDs prefixed as `folder:<path>` (for example, `folder:photos/2026`). When navigating into this folder, pass `folderId=photos/2026` or `folderId=folder:photos/2026` in subsequent API calls.
- **Zero-Copy Instant Operations:** Because folder hierarchies and names live in the database:
  - Renaming a file updates `name` in `tg_files` instantly without re-uploading to Telegram.
  - Moving a file between folders updates `folder` in `tg_files` instantly without transferring data.
  - Deleting a file checks if other cloned references share the same `messageId`; if it's the last reference, it revokes and deletes the Telegram channel message as well.

---

## 6. File & Folder Operations

### 6.1 List Files and Folders
Fetches files and subfolders within a specific account and directory.
- **Method & Route:** `GET /api/files`
- **Auth Required:** Yes
- **Query Parameters:**
  - `accountId` *(Required)*: ID of the storage account/drive.
  - `folderId` *(Optional)*: Folder ID to view (use `"root"` or omit for the root directory).
  - `search` *(Optional)*: Search keyword to filter items by name.
  - `limit` *(Optional)*: Pagination limit between 1 and 200 (default: `100`).
  - `cursor` *(Optional, tgdrive only)*: Base64-encoded pagination cursor (`${date}:${_id}`).
- **Caching & ETags:**
  - Every account type includes a weak ETag header (`ETag: W/"<hash>"`).
  - Sending `If-None-Match: W/"<hash>"` responds with `304 Not Modified` if data is unchanged.
  - Drive and OneDrive listing queries are cached in a 60-second NodeCache, automatically invalidated upon upload, delete, rename, move, copy, or folder creation.
- **Pagination Headers (tgdrive):**
  - If additional files are available beyond `limit`, the response includes an `X-Next-Cursor` header with the cursor for the next page.
  - Folders are only returned when no `cursor` is provided and no `search` is active.
- **Response (200 OK):** Plain JSON array of normalized items (every item includes formatted `size` and numeric `sizeBytes`):
  ```json
  [
    {
      "id": "folder:documents/work",
      "name": "work",
      "type": "folder",
      "size": "-",
      "sizeBytes": 0,
      "modified": "-",
      "createdAt": "-",
      "folder": "documents/work",
      "isTgDrive": true,
      "updatedAt": 1718000000000,
      "thumbUrl": null
    },
    {
      "id": "65d8a2b5e4b0222222222222",
      "name": "presentation.mp4",
      "type": "video",
      "size": "42.5 MB",
      "sizeBytes": 44564480,
      "modified": "10/27/2026",
      "createdAt": "10/27/2026",
      "mimeType": "video/mp4",
      "folder": "",
      "shareId": "a1b2c3",
      "isTgDrive": true,
      "updatedAt": 1729980000000,
      "thumbUrl": "/api/thumb/65d8a1f2e4b0111111111111/65d8a2b5e4b0222222222222?s=256"
    }
  ]
  ```

### 6.2 Get File Thumbnail
Generates or serves an optimized cover thumbnail for images and videos across Telegram Drive, Google Drive, and OneDrive.
- **Method & Route:** `GET /api/thumb/:accountId/:fileId`
- **Auth Required:** Yes (`Authorization: Bearer <session_token>` or `?token=<session_token>`)
- **Query Parameters:**
  - `s` *(Optional)*: Thumbnail dimension in pixels, clamped between 64 and 512 (default: `256`).
- **Caching & Performance:**
  - **Disk Cache:** Cached locally on disk (`${THUMB_DIR}/${fileId}_${s}.jpg`).
  - **Concurrency:** Limited to 4 parallel image processing pipelines via `p-limit(4)` with deduplication for in-flight requests.
  - **Response Headers:**
    - On 200 OK: `Cache-Control: private, max-age=31536000, immutable`, `ETag: "${fileId}_${s}"`
    - On 404: `Cache-Control: private, max-age=300`
    - Returns `304 Not Modified` if `If-None-Match` matches.
  - **Storage Management:** Directory capped at 500 MB; oldest thumbnails by mtime are pruned periodically.
- **Provider Thumbnail Strategies:**
  - *Telegram Drive:* Downloads the smallest thumbnail >= `s` px from media document thumbs / photo sizes. If none exists and file is an image under 10 MB, downloads and generates from media.
  - *Google Drive:* Fetches Google's `thumbnailLink` and resizes via Sharp (`fit: cover`, `jpeg: 75`).
  - *OneDrive:* Fetches Microsoft Graph item thumbnails (medium/large) and resizes via Sharp.

### 6.3 Create Folder
Creates a new directory in the selected drive.
- **Method & Route:** `POST /api/folders?accountId=:accountId`
- **Auth Required:** Yes
- **Request Body (JSON):**
  ```json
  {
    "name": "Documents",
    "parentId": "root"
  }
  ```
- **Response (200 OK):** `{ "success": true }`

### 6.4 Upload File & Resumable Upload Sessions
Uploads a file to a specific storage drive and destination folder using disk-streamed staging in `TEMP_DIR` (supports files up to 2 GB with zero RAM buffering, per-user concurrency limits, daily upload byte quotas, and `Idempotency-Key` deduplication).

#### 6.4.1 Direct Multipart Upload (`POST /api/upload/:accountId`)
- **Method & Route:** `POST /api/upload/:accountId`
- **Auth Required:** Yes
- **Headers:** `Idempotency-Key: <unique-key>` *(Optional, recommended for safe retries)*
- **Content-Type:** `multipart/form-data`
- **Form Fields:**
  - `file`: Binary file data.
  - `folderId`: Target folder ID (or `"root"`).
  - `idempotencyKey`: Optional idempotency key if not passed via header.
- **Response (200 OK):**
  ```json
  {
    "success": true
  }
  ```

#### 6.4.2 Resumable / Chunked Upload Sessions (`/api/upload-sessions/*`)
Recommended for large files and interrupted networks:
1. **Create Session:** `POST /api/upload-sessions/:accountId`
   - **Headers:** `Idempotency-Key: <key>` *(Optional if passed in JSON body)*
   - **Body (JSON):** `{ "fileName": "video.mp4", "mimeType": "video/mp4", "totalBytes": 104857600, "chunkSize": 2097152, "folderId": "root", "checksum": "<optional-sha256-hex>", "deduplicate": false, "idempotencyKey": "<key>" }` *(Note: `size` and `desiredChunkSize` are also accepted as aliases for `totalBytes` and `chunkSize`)*.
   - **Quota & Duplicate Checks:**
     - Normalizes unsafe characters/path traversal in `fileName` via `normalizeSafeFilename`.
     - Verifies target account storage quota headroom when cached quota metadata is available (`403 INSUFFICIENT_STORAGE` if full).
     - When `deduplicate: true` and `checksum` are supplied, checks if an identical non-trashed file already exists in the target folder and returns `{ deduplicated: true, status: "completed", existingFileId }` (`200 OK`) without re-uploading.
   - **Response (`201 Created` or `200 OK` on idempotent replay):** Returns session descriptor `{ sessionId, status: "active", receivedBytes, totalBytes, chunkSize, expiresAt, ... }`.
2. **Inspect Session State:** `GET /api/upload-sessions/:sessionId`
   - Returns current `status` (`active`, `paused`, `completing`, `completed`, `expired`, `cancelled`), `receivedBytes`, and `totalBytes`.
3. **Upload Chunk (Zero-Double-Write Direct Stream or Multipart):** `PUT /api/upload-sessions/:sessionId/chunks`
   - **Recommended Direct Stream Mode (`Content-Type: application/octet-stream`):** Send raw chunk bytes in the request body with `X-Chunk-Offset: <byte_offset>` (or `Content-Range: bytes <start>-<end>/<total>`), `Content-Length`, and optional `X-Chunk-Sha256: <hex>`. Streams directly into `session.tempPath` while computing SHA-256 on the fly with zero intermediate Multer disk write.
   - **Multipart Mode (`Content-Type: multipart/form-data`):** Send `chunk` binary field + `offset` form field (or `X-Chunk-Offset` / `Content-Range` header) and optional `X-Chunk-Sha256`.
   - **Per-Chunk Integrity:** If `X-Chunk-Sha256` (or `chunkChecksum` body field) is provided and does not match the received chunk digest, the chunk is rejected (`422 BAD_REQUEST`) and the file is truncated back to `session.receivedBytes`.
   - **Response (`200 OK`):** `{ sessionId, receivedBytes, totalBytes, nextOffset, complete }`. Returns `409 UPLOAD_SESSION_NOT_ACTIVE` if paused, `409 UPLOAD_SESSION_OFFSET_CONFLICT` on mismatched offset, or `410 UPLOAD_SESSION_EXPIRED` if expired. Exact chunk replays with matching SHA-256 are acknowledged idempotently (`200 OK`).
4. **Pause Session:** `POST /api/upload-sessions/:sessionId/pause`
   - Transitions an `active` session to `paused` (`200 OK`).
5. **Resume Session:** `POST /api/upload-sessions/:sessionId/resume`
   - Transitions a `paused` session back to `active` (`200 OK`).
6. **Complete Session:** `POST /api/upload-sessions/:sessionId/complete`
   - Acquires a completion lease lock, verifies received byte size and full-file SHA-256 checksum, inspects file magic bytes and ZIP central directory compression ratios via `sniffMagicMimeType` to block archive bombs (`400 ARCHIVE_BOMB_DETECTED`), streams the staged file to the target provider (persisting upstream OneDrive `nextExpectedRanges` or Google Drive resumable upload URIs), records an audit event, and cleans up temporary staging files.
7. **Cancel Session:** `DELETE /api/upload-sessions/:sessionId` (or `POST /api/upload-sessions/:sessionId/cancel`)
   - Marks the session `cancelled` and immediately unlinks staged temp files.

### 6.5 Download or Stream File (`GET` & `HEAD`)
Streams or downloads a file from any linked drive (Telegram, Google Drive, OneDrive).
- **Method & Route:** `GET /api/download/:accountId/:fileId` and `HEAD /api/download/:accountId/:fileId`
- **Auth Required:** Yes (`Authorization` header, `?token=<session_token>`, or signed media URL)
- **Query Parameters:**
  - `preview=1` *(Optional)*: Sets `Content-Disposition: inline` instead of `attachment`, enabling in-app preview for images, PDFs, and video playback.
- **Headers & Streaming:**
  - Always sends `Accept-Ranges: bytes`, `Cache-Control: private, no-cache` (never cached publicly), `Content-Type`, `Content-Length`, `ETag`, and RFC 6266 / 5987 safe `Content-Disposition` (`buildSafeContentDisposition`).
  - Supports `HEAD` requests to inspect file size, MIME type, and ETag before downloading bytes.
  - Enforces per-user concurrent download limits (`MAX_CONCURRENT_DOWNLOADS_PER_USER`) and idle-stream timeouts (`DOWNLOAD_IDLE_TIMEOUT_MS`), destroying upstream provider streams immediately on client disconnect.

#### 6.5.1 One-Time & Short-Lived Download Tickets (`/api/download-tickets`)
Issue a short-lived or single-use download ticket so native media players, external download managers, or browser downloads never expose bearer tokens in query strings.
- **Create Download Ticket:** `POST /api/download-tickets`
  - **Auth Required:** Yes (`read` scope)
  - **Request Body (JSON):**
    ```json
    {
      "accountId": "65d8a1f2e4b0111111111111",
      "fileId": "65d8a2b5e4b0222222222222",
      "singleUse": true,
      "ttlSeconds": 300,
      "preview": false
    }
    ```
  - **Response (201 Created):**
    ```json
    {
      "ticket": "dlt_to9rx7sqlbwp3n1ow6nnj3g3cj0333sg",
      "downloadUrl": "/api/download/ticket/dlt_to9rx7sqlbwp3n1ow6nnj3g3cj0333sg",
      "expiresAt": "2026-11-18T09:52:29.369Z",
      "singleUse": true
    }
    ```
- **Redeem Ticket & Stream File:** `GET /api/download/ticket/:ticket`
  - **Auth Required:** No (the ticket itself is the capability)
  - **Behavior:** Atomically marks `singleUse: true` tickets as consumed (`usedCount: 1`) and streams the file with full HTTP `Range` support. Subsequent requests to a consumed single-use ticket or expired/revoked ticket return `410 Gone`.
- **Revoke Ticket:** `DELETE /api/download-tickets/:ticket`
  - **Auth Required:** Yes
  - **Response (200 OK):** `{ "success": true }`

### 6.6 Rename File
Renames an existing file or folder.
- **Method & Route:** `PATCH /api/files/:fileId?accountId=:accountId`
- **Auth Required:** Yes
- **Request Body (JSON):**
  ```json
  {
    "name": "updated_document_name.pdf"
  }
  ```
- **Response (200 OK):** `{ "success": true }`

### 6.7 Delete & Trash / Restore Operations (Telegram Drive, Google Drive & OneDrive)
- **Soft-Delete / Move to Trash:** `DELETE /api/files/:fileId?accountId=:accountId`
  - Soft-deletes the item into the drive's Trash across all three providers (`tgdrive`, `google`, and `onedrive`) and hides it from `GET /api/files`. Pass `?permanent=true` to bypass Trash and permanently delete immediately.
- **List Trash:** `GET /api/trash?accountId=:accountId`
  - Lists trashed items for a specific drive (`accountId=<id>`) or across all linked drives (`accountId=all` or omitted). For OneDrive, merges tracked trashed items with Microsoft Graph Recycle Bin (`/me/drive/special/recyclebin/children`).
- **Restore from Trash:** `POST /api/trash/restore`
  - **Body (JSON):** `{ "accountId": "<id>", "fileId": "<id>" }`
  - Restores the file in Telegram Drive, Google Drive (`trashed: false`), or OneDrive (`/me/drive/items/:id/restore`) and invalidates the drive cache.
- **Permanently Delete Single Item from Trash:** `DELETE /api/trash/:fileId?accountId=:accountId`
  - Permanently removes the file from the provider and revokes the backing Telegram channel message when no references remain.
- **Empty Trash (Per-Drive or All Drives):** `DELETE /api/trash?accountId=:accountId`
  - Permanently deletes all trashed items in the specified drive (or all linked drives if `accountId=all`). Returns `{ "success": true, "deletedCount": <number> }`.

---

## 7. Move & Copy Endpoints (Same-Drive & Cross-Drive Transfer)

Cloudyte features a unified file movement and cloning engine that supports both **intra-drive operations** and **seamless cross-cloud transfers** (e.g. moving a file from Telegram Drive to Google Drive, or copying between two OneDrive accounts).

### 7.1 Move File (`POST /api/files/move`)
Moves a file or folder to a new directory within the same account, or transfers it across different linked storage accounts.

- **Method & Route:** `POST /api/files/move`
- **Auth Required:** Yes
- **Request Body (JSON):**
  ```json
  {
    "sourceAccountId": "65d8a1f2e4b0111111111111",
    "fileId": "65d8a2b5e4b0222222222222",
    "targetAccountId": "65d8a1f2e4b0333333333333",
    "targetFolderId": "root"
  }
  ```
- **Field Details:**
  - `sourceAccountId` *(string, required)*: The account/drive where the file currently resides.
  - `fileId` *(string, required)*: The unique ID of the file to move.
  - `targetAccountId` *(string, required)*: The target account/drive (can be equal to `sourceAccountId` or a different drive).
  - `targetFolderId` *(string, required)*: Destination folder ID (use `"root"` for top-level root folder).
- **Execution Behaviors:**
  - **Same-Account Move (`sourceAccountId === targetAccountId`):**
    - *Telegram Drive:* Instantly updates the folder parent pointer in MongoDB.
    - *Google Drive:* Invokes Google Drive API `drive.files.update` with `addParents` and `removeParents`.
    - *OneDrive:* Invokes Microsoft Graph API `PATCH /me/drive/items/{id}` with `parentReference`.
  - **Cross-Account Transfer (`sourceAccountId !== targetAccountId`):**
    - Streams the file from the source drive into a temporary local buffer (`/tmp`).
    - Uploads the file stream into the target drive under `targetFolderId`.
    - Automatically deletes the original file from the source drive upon successful transfer.
    - Cleans up the temporary buffer.
- **Response (200 OK):**
  ```json
  {
    "success": true
  }
  ```
- For a cross-account transfer, add `?async=true` to receive `202 Accepted` with `{ "success": true, "async": true, "jobId": "...", "status": "queued" }`. Poll `GET /api/jobs/:jobId` for completion.
- **Errors:**
  - `400 Bad Request` (invalid account or unsupported drive type)
  - `404 Not Found` (source file or account does not exist / does not belong to user)
  - `500 Internal Server Error` (transfer or permission failure)

---

### 7.2 Copy File (`POST /api/files/copy`)
Duplicates a file in the destination directory or clones it across different storage providers without altering the source file.

- **Method & Route:** `POST /api/files/copy`
- **Auth Required:** Yes
- **Request Body (JSON):**
  ```json
  {
    "sourceAccountId": "65d8a1f2e4b0111111111111",
    "fileId": "65d8a2b5e4b0222222222222",
    "targetAccountId": "65d8a1f2e4b0333333333333",
    "targetFolderId": "root"
  }
  ```
- **Field Details:**
  - `sourceAccountId` *(string, required)*: The account/drive of the source file.
  - `fileId` *(string, required)*: The unique ID of the file to copy.
  - `targetAccountId` *(string, required)*: The destination account/drive.
  - `targetFolderId` *(string, required)*: Destination folder ID (`"root"` or specific folder ID).
- **Execution Behaviors:**
  - **Same-Account Copy (`sourceAccountId === targetAccountId`):**
    - *Telegram Drive:* Clones the metadata document in MongoDB. If copied into the same folder, automatically appends `" - Copy"` to the filename (e.g. `report - Copy.pdf`).
    - *Google Drive:* Calls Google Drive API `drive.files.copy` with target parent.
    - *OneDrive:* Calls Microsoft Graph API `POST /me/drive/items/{id}/copy` with target parent reference.
  - **Cross-Account Copy (`sourceAccountId !== targetAccountId`):**
    - Streams the source file to a temporary buffer.
    - Uploads the cloned file to the target account.
    - Preserves the original file untouched in the source account.
    - Cleans up the temporary buffer.
- **Response (200 OK):**
  ```json
  {
    "success": true
  }
  ```
- For a cross-account copy, add `?async=true` to receive `202 Accepted` with a durable job ID. Poll `GET /api/jobs/:jobId` for completion.

---

### 7.3 Unified Operation & Multi-Queue Background Jobs (`GET /api/jobs*`, `POST /api/jobs/:jobId/*`)
- **Multi-Queue Worker Architecture:** Processed by up to `MAX_CONCURRENT_JOBS` (default `3`) parallel background workers with atomic MongoDB lease locks (`leaseExpiresAt`, `workerId`), priority ordering, heartbeat tracking, and per-account-pair serialization (`providerLimit("transfer:source:target", 1)`).
- **Supported Queue Types:** `cross_account_transfer`, `batch_backup`, `batch_restore`, `trash_cleanup`, `thumb_generation`, `provider_sync`.
- **Safe Move Verification Fence:** On cross-account moves (`isMove: true`), the worker verifies that the destination provider returned a real file identifier (`id` / `_id` / `messageId`) AND that `verifiedBytes === sourceSize`, then writes `sourceDeleteApproved: true` into `transfer_manifests` before deleting the source file.
- **List Operations:** `GET /api/jobs?status=<optional_status>`
  - Returns the authenticated user's recent background operations.
- **Get Operation Status:** `GET /api/jobs/:jobId`
  - **Response (Unified Operation Model):**
    ```json
    {
      "id": "job_01",
      "jobId": "job_01",
      "userId": "user_1",
      "accountId": "65d8a1f2e4b0111111111111",
      "type": "cross_account_transfer",
      "status": "completed",
      "stage": "completed",
      "source": { "accountId": "65d8a1f2e4b0111111111111", "fileId": "f1" },
      "destination": { "accountId": "65d8a1f2e4b0222222222222", "folderId": "root", "fileId": "gd_99" },
      "progress": 100,
      "progressPct": 100,
      "bytesProcessed": 1024,
      "totalBytes": 1024,
      "itemsProcessed": 1,
      "totalItems": 1,
      "retryCount": 0,
      "attempts": 1,
      "maxAttempts": 3,
      "deadLettered": false,
      "cancellationRequested": false,
      "cancelRequested": false,
      "sourceDeleteApproved": true,
      "createdAt": "2026-11-18T09:00:00.000Z",
      "startedAt": "2026-11-18T09:00:01.000Z",
      "completedAt": "2026-11-18T09:00:03.000Z",
      "expiresAt": null,
      "error": null
    }
    ```
- **Queue Health & Worker Heartbeat Endpoint:** `GET /api/jobs/health`
  - **Response (200 OK):** Returns `{ ok: true, workerHealthy: true, lastWorkerHeartbeatAt, activeJobs, maxConcurrentJobs, activeTransfers, queues: { cross_account_transfer: { queued, running, retrying, deadLetter, completed, failed, cancelled }, ... } }`.
- **Real-Time Job Progress Stream (SSE):** `GET /api/jobs/:jobId/stream`
  - Streams Server-Sent Events (`text/event-stream`) as job `stage` and `progressPct` advance until completion, failure, or cancellation.
- **Cancel Job:** `POST /api/jobs/:jobId/cancel`
  - Cooperatively cancels a `queued` or `running` job, aborts in-flight transfers via an atomic cancellation fence, and guarantees the source file is never deleted on a cancelled move.
- **Retry Failed / Cancelled Job:** `POST /api/jobs/:jobId/retry`
  - Resets `status` to `queued` and clears dead-letter flags so the worker re-processes the job idempotently.

### 7.4 Multi-File Batch Backup, Verification, and Conflict-Safe Restore (`/api/backups/*`)
- **Enqueue Batch Backup:** `POST /api/backups/batch`
  - **Request Body (JSON):**
    ```json
    {
      "sourceAccountId": "65d8a1f2e4b0111111111111",
      "targetAccountId": "65d8a1f2e4b0222222222222",
      "targetFolderId": "root",
      "fileIds": ["65d8a2b5e4b0222222222222", "65d8a2b5e4b0333333333333"],
      "conflictStrategy": "rename"
    }
    ```
  - **Behavior:** Runs in the background job queue (`202 Accepted` with `jobId`). Isolates partial failures so a single failed file is recorded in `manifest.failedFiles` while remaining files complete (`completed_with_errors`). Writes a recovery manifest in `transfer_manifests`.
- **Verify Backup Manifest:** `POST /api/backups/:jobId/verify`
  - Verifies that all backed-up files exist in the target account and match expected byte sizes.
  - **Response (200 OK):** `{ "jobId": "...", "verified": true, "totalItems": 2, "verifiedCount": 2, "failedVerifications": [], "verifiedAt": "..." }`
- **Restore Backup (Non-Destructive Conflict Copies):** `POST /api/backups/:jobId/restore`
  - **Request Body (JSON):** `{ "targetAccountId": "...", "targetFolderId": "root", "conflictStrategy": "rename" }`
  - **Behavior:** Restores completed backup items as a `batch_restore` background job (`202 Accepted`). Defaults to `conflictStrategy: "rename"` so existing destination files are **never silently overwritten** (conflicting filenames are saved as `<name> (conflict copy).<ext>`).

## 8. Public Share Links (7-Point Validated)

Every public share request (`/s/:shareId` and `/api/public/download/:shareId`) enforces a **7-point live validation check**:
1. Share record exists
2. Share is active (`revokedAt == null`)
3. Share has not expired (`expiresAt`)
4. Share download count is within `maxDownloads` and `allowDownload !== false`
5. Optional share PIN matches (`?pin=<pin>` or `X-Share-Pin: <pin>`)
6. Linked storage account exists and is active
7. Underlying file still exists on the provider and is **neither trashed nor permanently deleted**

### 8.1 Create Public Share Link
Generates a shareable URL for any non-encrypted file with optional expiration, download cap, and PIN protection.
- **Method & Route:** `POST /api/share`
- **Auth Required:** Yes (`share` scope)
- **Request Body (JSON):**
  ```json
  {
    "accountId": "65d8a1f2e4b0111111111111",
    "fileId": "65d8a2b5e4b0222222222222",
    "expiresInHours": 48,
    "maxDownloads": 10,
    "pin": "4321",
    "allowDownload": true
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "shareId": "a1b2c3",
    "shareUrl": "https://your-domain.com/s/a1b2c3",
    "expiresAt": "2026-11-20T09:00:00.000Z",
    "maxDownloads": 10,
    "hasPin": true,
    "allowDownload": true
  }
  ```

### 8.2 List & Revoke Public Shares
- **List Active Shares:** `GET /api/shares`
  - Returns the authenticated user's active shares (`shareId`, `accountId`, `fileId`, `fileName`, `createdAt`, `expiresAt`, `maxDownloads`, `downloadCount`, `hasPin`, `allowDownload`).
- **Revoke Share:** `DELETE /api/share/:shareId`
  - Marks the share as revoked (`revokedAt`) so `/s/:shareId` and `/api/public/download/:shareId` immediately stop serving the file (`200 OK`: `{ "success": true }`).

### 8.3 Public Direct Download
Direct binary file stream for shared files (no auth required; pass `?pin=<pin>` or `X-Share-Pin` if PIN-protected).
- **Method & Route:** `GET /api/public/download/:shareId`
- **Auth Required:** No
- **Response:** Binary file stream with safe RFC 6266 `Content-Disposition: attachment`. Supports video range streaming and increments `downloadCount`.

### 8.4 Public Share Landing Page
HTML preview and download web page for end users (pass `?pin=<pin>` if PIN-protected).
- **Method & Route:** `GET /s/:shareId`
- **Auth Required:** No
- **Response:** Styled HTML landing page with file metadata, thumbnail preview, and direct download button.

---

## 9. Admin Endpoints

All admin endpoints require an authenticated session where `isAdmin: true` or HTTP Basic Auth.

### 9.1 Get Platform Stats
- **Route:** `GET /api/admin/stats`
- **Response:** `{ "totalUsers": 12, "totalAccounts": 25, "totalFiles": 1420 }`

### 9.2 List All Users
- **Route:** `GET /api/admin/users`
- **Response:** Array of user records with creation date, account status, and linked account count.

### 9.3 Get User Details & Accounts
- **Route:** `GET /api/admin/users/:id`
- **Response:** Detailed user record, list of linked drives, and storage stats.

### 9.4 Toggle User Active / Suspended
- **Route:** `POST /api/admin/users/:id/toggle`
- **Response:** `{ "success": true, "isActive": false }`

### 9.5 Delete User Account
Permanently deletes the user and all their linked accounts and file references.
- **Route:** `DELETE /api/admin/users/:id`
- **Response:** `{ "success": true }`

### 9.6 Get Global Admin Settings
- **Route:** `GET /api/admin/settings`
- **Response:** Global configuration flags (`registrationEnabled`, `webRegistrationEnabled`, `botRegistrationEnabled`).

### 9.7 Update Global Admin Setting
- **Route:** `POST /api/admin/settings`
- **Request Body (JSON):**
  ```json
  {
    "key": "registrationEnabled",
    "value": false
  }
  ```
- **Response:** `{ "success": true }`

### 9.8 Get System & Provider Observability Metrics
Returns real-time process health, CPU, memory, event-loop lag, open file descriptors, active connections/uploads/downloads, upload/download byte throughput, OAuth refresh failure counts, worker heartbeats, temp/thumb disk usage, job queue depth, dead-letter job counts, cache hit/miss stats, per-provider call telemetry, and active threshold alerts.
- **Method & Route:** `GET /api/admin/metrics`
- **Auth Required:** Admin session or Admin Basic Auth
- **Response (200 OK):**
  ```json
  {
    "uptimeSeconds": 1420,
    "activeConnections": 2,
    "eventLoopLagMs": 1.4,
    "openFileDescriptors": 42,
    "memoryUsage": { "rss": 98566144, "heapTotal": 45088768, "heapUsed": 32112640 },
    "disk": { "tempFreeHeadroomOk": true, "tempDirBytes": 0, "tempFileCount": 0, "thumbDirBytes": 1245184 },
    "uploads": { "activeGlobal": 0, "completed": 15, "failed": 0, "bytesTotal": 104857600 },
    "downloads": { "activeGlobal": 0, "bytesTotal": 52428800 },
    "jobs": {
      "queued": 0,
      "running": 0,
      "failed": 0,
      "deadLetter": 0,
      "transfersCompleted": 8,
      "transfersFailed": 0,
      "workerHeartbeats": 284,
      "lastWorkerHeartbeatAt": "2026-11-18T09:47:29.000Z"
    },
    "oauth": { "refreshFailures": 0 },
    "cache": {
      "driveCacheKeys": 14,
      "driveCacheHits": 120,
      "driveCacheMisses": 14,
      "thumbCacheKeys": 8,
      "failedThumbCacheKeys": 0,
      "authCacheKeys": 3
    },
    "providers": {
      "google": { "calls": 24, "errors": 0, "retries": 1, "totalDurationMs": 3120 },
      "onedrive": { "calls": 10, "errors": 0, "retries": 0, "totalDurationMs": 1450 },
      "telegram": { "calls": 40, "errors": 0, "retries": 0, "totalDurationMs": 980 }
    },
    "alerts": []
  }
  ```

### 9.9 Security & Operational Audit Logs
Queries structured security and operational audit records persisted in `audit_logs` (90-day automatic TTL retention, with automatic credential/token redaction).
- **Method & Route:** `GET /api/admin/audit-logs`
- **Auth Required:** Admin session or Admin Basic Auth
- **Query Parameters:**
  - `userId` *(Optional)*: Filter logs by user ID.
  - `action` *(Optional)*: Filter by audit action (e.g. `login_success`, `login_failed`, `api_token_created`, `api_token_revoked`, `auth_scope_denied`, `auth_confinement_denied`, `file_uploaded`, `file_downloaded`, `file_deleted`, `share_created`, `share_revoked`, `public_share_downloaded`, `oauth_refresh_failed`).
  - `limit` *(Optional)*: Max records to return (`1..500`, default `100`).
- **Response (200 OK):** Array of audit log documents ordered newest-first.

---

## 10. Android & Mobile Developer Quick Reference

| Feature | Endpoint | HTTP Method | Auth | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Health Check** | `/healthz` | GET | None | Liveness check returns `{ "ok": true, "uptimeSec": ... }` |
| **Readiness Check** | `/readyz` | GET | None | Checks MongoDB connectivity and temp disk headroom |
| **Login** | `/api/login` | POST | None | Progressive throttling & lockout; returns Bearer `token` |
| **Register** | `/api/register` | POST | None | Rate limited (10/min) |
| **Active Sessions** | `/api/sessions` | GET / DELETE | Bearer | List or revoke active device sessions (with IP history) |
| **Personal Access Tokens**| `/api/tokens` | GET / POST / DELETE | Bearer | Scoped PATs (`read`, `write`, `delete`, `share`) + account/folder confinement |
| **List Drives** | `/api/accounts` | GET | Bearer | Returns all linked drives |
| **Storage Summary** | `/api/storage/summary` | GET | Bearer | Pass `?accountId=<id>` or `all`; returns `usedBytes`, `totalBytes`, `fileCount`, `categories` |
| **Google OAuth** | `/api/auth/drive-link` | GET | Bearer | Open returned `url` in Chrome Custom Tabs |
| **OneDrive OAuth** | `/api/auth/onedrive-link` | GET | Bearer | Open returned `url` in Chrome Custom Tabs |
| **Add TG Drive** | `/api/tgdrive/register` | POST | Bearer | Pass `channelId` and `driveName` |
| **List Files** | `/api/files` | GET | Bearer | Supports `cursor`, `limit`, weak ETag 304, returns `sizeBytes`, `updatedAt` & `thumbUrl` |
| **Thumbnail** | `/api/thumb/:accId/:fileId` | GET | Bearer or `?token=` | Optimized image/video thumbnail with negative retry cache, `?s=256` |
| **Create Folder** | `/api/folders` | POST | Bearer | Pass `name` & `parentId` |
| **Upload File** | `/api/upload/:accountId` | POST | Bearer | Multipart Form: `file` & `folderId` + `Idempotency-Key` |
| **Upload Sessions** | `/api/upload-sessions/:accId` | POST / PUT / GET / DELETE | Bearer | Resumable chunked uploads (`X-Chunk-Sha256`, deduplication, quota & archive-bomb checks) |
| **Download/Stream** | `/api/download/:accId/:fileId`| GET / HEAD | Bearer or `?token=` | Supports `Range`, `HEAD`, RFC 6266/5987, ETag 304, and `?preview=1` |
| **Download Tickets** | `/api/download-tickets` | POST / DELETE | Bearer | Issue or revoke short-lived / single-use download tickets (`dlt_...`) |
| **Redeem Ticket** | `/api/download/ticket/:ticket`| GET | None | Stream file using a short-lived or one-time download ticket |
| **Trash Management** | `/api/trash` | GET / POST / DELETE | Bearer | List trashed files, `/api/trash/restore`, or permanent delete |
| **Move File** | `/api/files/move` | POST | Bearer | Supports same-drive & cross-drive transfers (`?async=true` for job queue) |
| **Copy File** | `/api/files/copy` | POST | Bearer | Supports same-drive & cross-drive cloning (`?async=true` for job queue) |
| **Jobs Queue** | `/api/jobs` | GET / POST | Bearer | Unified Operation model, `/api/jobs/health`, SSE `/stream`, `/cancel`, `/retry` |
| **Batch Backups** | `/api/backups/batch` | POST | Bearer | Background batch backup, `/:jobId/verify`, and conflict-safe `/:jobId/restore` |
| **Share Links** | `/api/share` & `/api/shares` | POST / GET / DELETE | Bearer | 7-point validated shares with `expiresInHours`, `maxDownloads`, `pin`, and revocation |
| **Public Download**| `/api/public/download/:shareId`| GET | None | 7-point validated direct file download (`?pin=` if PIN-protected) |
| **Put Key Backup** | `/api/accounts/:id/encryption/key-backup` | PUT | Bearer | Store opaque PBKDF2-wrapped encryption key backup |
| **Get Key Backup** | `/api/accounts/:id/encryption/key-backup` | GET | Bearer | Retrieve opaque wrapped encryption key backup |
| **Delete Key Backup**| `/api/accounts/:id/encryption/key-backup` | DELETE | Bearer | Delete stored key backup (`204 No Content`) |
| **Admin Metrics** | `/api/admin/metrics` | GET | Admin | Full process, disk, provider, queue, cache, and alert telemetry |
| **Admin Audit Logs** | `/api/admin/audit-logs` | GET | Admin | Query structured security and operational audit records |

---

## 11. Client-Side End-to-End Encryption (E2EE / Zero-Knowledge Mode)

Cloudyte supports full client-side end-to-end encryption (`CYTE1` binary format with `AES-256-GCM` chunked encryption) while preserving full backward compatibility with plaintext files.

### 11.1 Privacy & Zero-Knowledge Guarantees
- The server stores and streams encrypted `CYTE1` bytes unchanged and **never** decrypts file contents or metadata.
- The server **never** receives, logs, or stores `CONTENT_KEY`, `recoveryPassphrase`, original plaintext filenames, original plaintext MIME types, or plaintext file hashes for encrypted files.
- For encrypted files:
  - Remote filename (`fileName` / `opaqueRemoteName`) must match `^cyte_[A-Za-z0-9_-]{4,120}\.(bin|cyte1|enc)$`.
  - `mimeType` must be `"application/octet-stream"`.
  - `encryptionFormatVersion` must be `1`.
  - `checksum` is the lowercase 64-character hex SHA-256 digest of the **encrypted** bytes.
  - Telegram channel messages use the opaque marker caption `"cloudyte:c1"`.

### 11.2 Encrypted Metadata Envelope
```json
{
  "metadataVersion": 1,
  "algorithm": "AES-256-GCM",
  "keyId": "key_primary_01",
  "nonce": "<base64url-encoded-12-byte-iv>",
  "ciphertext": "<base64url-encoded-ciphertext-and-auth-tag>"
}
```

### 11.3 Direct Encrypted Upload (`POST /api/upload/:accountId`)
In addition to the `file` multipart binary field, include the following form fields when `isEncrypted=true`:
- `isEncrypted`: `"true"`
- `fileName`: `"cyte_<random>.cyte1"`
- `opaqueRemoteName`: `"cyte_<random>.cyte1"` (must equal `fileName`)
- `mimeType`: `"application/octet-stream"`
- `size` / `encryptedSizeBytes`: Exact encrypted byte length
- `checksum`: SHA-256 hex digest of the encrypted file bytes
- `encryptionFormatVersion`: `"1"`
- `encryptionKeyId`: Opaque key identifier (`1..128` chars)
- `encryptedMetadata`: JSON string of the encrypted metadata envelope (max 64 KiB)

### 11.4 Resumable Encrypted Upload Sessions (`/api/upload-sessions/*`)
- **`POST /api/upload-sessions/:accountId`**: Accepts `isEncrypted: true`, `fileName`, `opaqueRemoteName`, `mimeType: "application/octet-stream"`, `size`, `encryptedSizeBytes`, `checksum` (SHA-256 of full encrypted file), `encryptionFormatVersion: 1`, `encryptionKeyId`, `encryptedMetadata`, and `idempotencyKey`.
- **`GET /api/upload-sessions/:sessionId`**: Returns session progress (`receivedBytes`, `totalBytes`) along with `isEncrypted`, `encryptionFormatVersion`, `encryptionKeyId`, `encryptedMetadata`, `opaqueRemoteName`, and `encryptedSizeBytes`.
- **`PUT /api/upload-sessions/:sessionId/chunks`**: Streams encrypted byte chunks. Exact idempotent chunk replays are accepted; conflicting chunk replays or out-of-order offsets return `409 UPLOAD_SESSION_OFFSET_CONFLICT`.
- **`POST /api/upload-sessions/:sessionId/complete`**: Verifies all encrypted bytes were received (`409 ENCRYPTED_UPLOAD_INCOMPLETE` if incomplete) and validates the full-file SHA-256 (`422 ENCRYPTED_CHECKSUM_MISMATCH` on mismatch) before committing to the storage provider.

### 11.5 File Listing, Download, Thumbnail & Share Behavior for Encrypted Files
- **`GET /api/files`**: Each item includes:
  - `isEncrypted`: `boolean`
  - `encryptionFormatVersion`: `1 | null`
  - `encryptionKeyId`: `string | null`
  - `encryptedChecksum`: `string | null`
  - `encryptedMetadata`: `EncryptedMetadataEnvelope | null`
  - `encryptedSizeBytes`: `number` (for encrypted files)
  - `thumbUrl`: Always `null` for encrypted files
  - `type`: Always `"other"` and `mimeType: "application/octet-stream"` for encrypted files
- **`GET /api/download/:accountId/:fileId`**: Streams raw encrypted `CYTE1` bytes with `Content-Type: application/octet-stream`, opaque `Content-Disposition` filename, `ETag: "<encryptedChecksum>"`, and full support for HTTP `Range: bytes=start-end` (`206 Partial Content`).
- **`GET /api/thumb/:accountId/:fileId`**: Immediately returns HTTP `409 Conflict` with `code: "ENCRYPTED_PREVIEW_UNAVAILABLE"` without invoking Sharp or upstream thumbnail APIs.
- **`POST /api/share`**: Immediately returns HTTP `409 Conflict` with `code: "ENCRYPTED_SHARE_UNSUPPORTED"` and never creates a public `shareId`.

### 11.6 Optional Zero-Knowledge Key Backup Endpoints
Clients may store an opaque PBKDF2-wrapped key backup per account. The server never receives the recovery passphrase or unwrapped content key.
- **`PUT /api/accounts/:accountId/encryption/key-backup`**
  - Request Body:
    ```json
    {
      "backupVersion": 1,
      "keyId": "key_primary_01",
      "kdfAlgorithm": "PBKDF2-HMAC-SHA256",
      "kdfIterations": 310000,
      "salt": "<base64url>",
      "wrapAlgorithm": "AES-256-GCM",
      "nonce": "<base64url>",
      "wrappedKey": "<base64url>"
    }
    ```
  - Validates `kdfIterations >= 100000` and max payload size `<= 16 KiB`.
- **`GET /api/accounts/:accountId/encryption/key-backup`**: Returns the stored key backup or `404 KEY_BACKUP_NOT_FOUND`.
- **`DELETE /api/accounts/:accountId/encryption/key-backup`**: Deletes the stored key backup and returns `204 No Content`.

### 11.7 E2EE Error Codes
| Error Code | HTTP Status | Description |
| :--- | :--- | :--- |
| `ENCRYPTED_METADATA_INVALID` | `400` | Missing or malformed `encryptedMetadata` envelope |
| `ENCRYPTED_METADATA_TOO_LARGE` | `413` | `encryptedMetadata` exceeds 64 KiB |
| `OPAQUE_FILENAME_REQUIRED` | `400` | Encrypted file name does not match `cyte_<id>.(bin\|cyte1\|enc)` |
| `ENCRYPTED_MIME_INVALID` | `400` | Encrypted upload MIME type is not `application/octet-stream` |
| `UNSUPPORTED_ENCRYPTION_VERSION` | `400` | `encryptionFormatVersion` is not `1` |
| `ENCRYPTED_SIZE_MISMATCH` | `400` | `size` and `encryptedSizeBytes` do not match |
| `ENCRYPTED_CHECKSUM_MISMATCH` | `422` | Uploaded encrypted bytes do not match expected SHA-256 |
| `ENCRYPTED_UPLOAD_INCOMPLETE` | `409` | Attempted to complete an encrypted upload session with missing bytes |
| `UPLOAD_SESSION_OFFSET_CONFLICT` | `409` | Chunk offset mismatch or conflicting chunk replay |
| `ENCRYPTED_PREVIEW_UNAVAILABLE` | `409` | Server-side thumbnail/preview requested for an encrypted file |
| `ENCRYPTED_SHARE_UNSUPPORTED` | `409` | Public share link requested for an encrypted file |
| `KEY_BACKUP_NOT_FOUND` | `404` | No key backup exists for the requested account |
| `KEY_BACKUP_INVALID` | `400` | Invalid key backup envelope or weak KDF iteration count |
| `KEY_BACKUP_TOO_LARGE` | `413` | Key backup exceeds 16 KiB |
| `ACCOUNT_ACCESS_DENIED` | `403` | Authenticated user does not own the target account, file, or session |
