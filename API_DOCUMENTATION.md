# Cloudyte API Documentation

This document provides a comprehensive, production-ready guide to all backend REST API endpoints and OAuth workflows in Cloudyte.
You can use this specification to integrate custom Android / iOS apps, desktop clients, command-line tools, or custom web frontends.

---

## 1. Architecture & Base URL

All API routes are served under the root URL of your deployed Cloudyte server.

- **Base URL Example:** `https://your-domain.com` (or `http://localhost:3000` in local development)
- **Content Type:** JSON (`application/json`) is expected for POST/PATCH bodies, except for `/api/upload/:accountId` which requires `multipart/form-data`.
- **Media Streaming:** Video, audio, and large file download endpoints support HTTP `Range` requests (`206 Partial Content`) for native media players (such as Android ExoPlayer / AVPlayer).

Large Android uploads use the resumable upload-session API. The server stages sequential chunks, owns the authoritative client-to-server byte offset, validates SHA-256 before commit, and then uses the selected account's provider-native upload protocol where available.

### 1.1 Resumable Upload Sessions

Create a session:

```http
POST /api/upload-sessions/:accountId
Authorization: Bearer <session_token>
Content-Type: application/json

{
  "fileName": "video.mp4",
  "mimeType": "video/mp4",
  "size": 10485760,
  "folderId": "root",
  "checksum": "<sha256-hex>",
  "idempotencyKey": "cloudyte-<transfer-id>",
  "providerType": "onedrive",
  "desiredChunkSize": 8388608
}
```

`accountId` is authoritative. `providerType` is optional for older clients; if supplied, it must match the selected account or the server returns `409 ACCOUNT_PROVIDER_MISMATCH`. The response includes `providerType`, `providerResumable` (whether the upstream provider's native session can be resumed), and `providerCancellable` (whether an upstream session can be safely aborted). Cloudyte's own staged upload remains resumable for Telegram, Google Drive, and OneDrive; Telegram reports `providerResumable: false` because GramJS's upstream `sendFile` operation does not expose a durable session/offset API.

Query `GET /api/upload-sessions/:sessionId` to reconcile `receivedBytes` after a retry or process restart. Upload sequential multipart field `chunk` parts with `Content-Range: bytes <start>-<end>/<total>`. A byte-identical replay of a committed range is acknowledged idempotently; a different replay or offset conflict returns `409 UPLOAD_OFFSET_CONFLICT`. Server writes are fenced, and a crash-left trailing staged suffix is truncated to the last committed offset before the next write. When `receivedBytes == totalBytes`, call `POST /api/upload-sessions/:sessionId/complete`. Completion is idempotent; a stale provider-completion lease can be reclaimed after ten minutes. Busy completion returns retryable `503 UPLOAD_COMPLETION_IN_PROGRESS`.

Google Drive uses a native resumable URI persisted server-side and reconciles it through the Google `308` / `Range` protocol. OneDrive persists its Graph `uploadUrl`, checks `nextExpectedRanges`, sends 320-KiB-aligned chunks, and can abort a persisted upload session. Expired provider sessions are recreated; OneDrive uses replace semantics and Google checks the transfer marker in `appProperties` to avoid duplicate completed files. Telegram uses GramJS `sendFile` and an idempotency marker in its metadata record; it cannot resume or abort a provider-native session after server restart. Zero-byte Google Drive and OneDrive files are supported; zero-byte Telegram documents return `422 UNSUPPORTED_PROVIDER_OPERATION`.

Cloudyte staging sessions expire after 24 hours. A query returns `status: "expired"`; chunk/complete requests return `410 UPLOAD_SESSION_EXPIRED`. Recreate an expired session with the original idempotency key. `DELETE /api/upload-sessions/:sessionId` removes staged data and is idempotent for a missing session. A stored OneDrive native session can also be aborted. Completed uploads cannot be cancelled; Google Drive/Telegram provider finalization that is already running returns `409 PROVIDER_CANCELLATION_UNSUPPORTED` rather than claiming a cancellation that cannot be guaranteed. The server validates SHA-256 before provider commit; checksum mismatches return `422 CHECKSUM_MISMATCH`.
---

## 2. Authentication

Most endpoints require user authentication. Supply the session token returned by `/api/login` in the standard HTTP `Authorization` header:

```http
Authorization: Bearer <session_token>
```

*Alternative Query Parameter:*
For media downloads or WebView rendering where setting custom headers is difficult, you can pass the token as a query parameter:
```
GET /api/download/:accountId/:fileId?token=<session_token>
```

*Admin Basic Auth:*
Admin endpoints also accept HTTP Basic Auth using the root credentials:
```http
Authorization: Basic <base64(admin_username:admin_password)>
```

---

## 3. Public & Auth Endpoints

> **Rate Limiting:** `/api/login` and `/api/register` are rate-limited to 10 requests per minute per IP address. Upload requests are limited to 30 per 15 minutes per IP by default and can be changed with `UPLOAD_REQUESTS_PER_WINDOW`. Exceeding a limit returns HTTP `429` with an `error` message and machine-readable `code: "RATE_LIMITED"`.

New server-level, upload, and rate-limit errors retain the existing string `error` field for compatibility and also include a stable `code` and `requestId` where available. Uploads are rejected with `507 INSUFFICIENT_STORAGE` when the server temporary directory does not have the configured free-space reserve. Provider uploads and cross-account transfers are bounded by per-account concurrency limits to prevent upstream overload.

### 3.1 Health Check
Liveness and uptime monitor.
- **Method & Route:** `GET /healthz`
- **Auth Required:** No
- **Response (200 OK):**
  ```json
  {
    "ok": true
  }
  ```

### 3.1.1 Readiness Check
Deployment readiness monitor. Returns `200` only after MongoDB initialization has completed; otherwise returns `503`.
- **Method & Route:** `GET /readyz`
- **Auth Required:** No

All responses include an `X-Request-ID` header. Include that ID when reporting an error so the corresponding server log entry can be located.

For large cross-account transfers, clients can opt into durable processing with `?async=true`. The server returns `202 Accepted` and a job ID; the job survives process restarts because it is stored in MongoDB.

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

### 3.4 User Login
Authenticate with username and password to receive a persistent session token. Subject to rate limits (10 req/min).
- **Method & Route:** `POST /api/login`
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
    "success": true,
    "token": "4f8a9e2b1c7d...",
    "username": "alice",
    "isAdmin": false
  }
  ```
- **Errors:** `401 Unauthorized` (invalid credentials or deactivated account), `429 Too Many Requests`.

### 3.5 Logout
Terminates and invalidates the session token in the database.
- **Method & Route:** `POST /api/logout`
- **Auth Required:** Yes
- **Response (200 OK):**
  ```json
  {
    "success": true
  }
  ```

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

### 6.4 Upload File
Uploads a file to a specific storage drive and destination folder using disk-streamed storage (supports files up to 2 GB with zero RAM buffering).
- **Method & Route:** `POST /api/upload/:accountId`
- **Auth Required:** Yes
- **Content-Type:** `multipart/form-data`
- **Form Fields:**
  - `file`: Binary file data.
  - `folderId`: Target folder ID (or `"root"`).
- **Response (200 OK):**
  ```json
  {
    "success": true
  }
  ```

### 6.5 Download or Stream File
Streams or downloads a file from any linked drive (Telegram, Google Drive, OneDrive).
- **Method & Route:** `GET /api/download/:accountId/:fileId`
- **Auth Required:** Yes (`Authorization` header or `?token=<session_token>`)
- **Query Parameters:**
  - `preview=1` *(Optional)*: Sets `Content-Disposition: inline` instead of `attachment`, enabling in-app preview for images, PDFs, and video playback. Sends `Cache-Control: private, max-age=86400`.
- **Headers & Streaming:**
  - Always sends `Accept-Ranges: bytes`.
  - Content-Disposition uses RFC 5987 standard: `filename*=UTF-8''<encoded_name>`.
  - For Telegram Drive: builds ETag `"${meta._id}-${meta.size}"` and returns `304 Not Modified` before contacting Telegram if `If-None-Match` matches.
  - Automatically aborts downloads on client disconnect (`res.on('close')`) and respects stream backpressure (`drain`).

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

### 6.7 Delete File
Permanently removes a file or folder and purges any associated cached thumbnails.
- **Method & Route:** `DELETE /api/files/:fileId?accountId=:accountId`
- **Auth Required:** Yes
- **Response (200 OK):** `{ "success": true }`

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

### 7.3 Durable Job Status
- **Method & Route:** `GET /api/jobs/:jobId`
- **Auth Required:** Yes
- **Response:** `{ "id": "...", "type": "cross_account_transfer", "status": "queued|running|completed|failed", "attempts": 1 }`
- **Retry:** `POST /api/jobs/:jobId/retry` retries a failed job owned by the authenticated user.

## 8. Public Share Links

### 8.1 Create Public Share Link
Generates a short shareable URL for any file (allows public access without authentication).
- **Method & Route:** `POST /api/share`
- **Auth Required:** Yes
- **Request Body (JSON):**
  ```json
  {
    "accountId": "65d8a1f2e4b0111111111111",
    "fileId": "65d8a2b5e4b0222222222222"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "shareUrl": "https://your-domain.com/s/a1b2c3"
  }
  ```

### 8.2 Public Direct Download
Direct binary file stream for shared files (no auth required).
- **Method & Route:** `GET /api/public/download/:shareId`
- **Auth Required:** No
- **Response:** Binary file stream with `Content-Disposition: attachment`. Supports video range streaming.

### 8.3 Public Share Landing Page
HTML preview and download web page for end users.
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

---

## 10. Android & Mobile Developer Quick Reference

| Feature | Endpoint | HTTP Method | Auth | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Health Check** | `/healthz` | GET | None | Liveness check returns `{ "ok": true }` |
| **Login** | `/api/login` | POST | None | Rate limited (10/min); returns Bearer `token` |
| **Register** | `/api/register` | POST | None | Rate limited (10/min) |
| **List Drives** | `/api/accounts` | GET | Bearer | Returns all linked drives |
| **Storage Summary** | `/api/storage/summary` | GET | Bearer | Pass `?accountId=<id>`; returns `usedBytes`, `totalBytes`, `fileCount`, `categories` |
| **Google OAuth** | `/api/auth/drive-link` | GET | Bearer | Open returned `url` in Chrome Custom Tabs |
| **OneDrive OAuth** | `/api/auth/onedrive-link` | GET | Bearer | Open returned `url` in Chrome Custom Tabs |
| **Add TG Drive** | `/api/tgdrive/register` | POST | Bearer | Pass `channelId` and `driveName` |
| **List Files** | `/api/files` | GET | Bearer | Supports `cursor`, `limit`, weak ETag 304, returns `sizeBytes`, `updatedAt` & `thumbUrl` |
| **Thumbnail** | `/api/thumb/:accId/:fileId` | GET | Bearer or `?token=` | Optimized image/video thumbnail, `?s=256` |
| **Create Folder** | `/api/folders` | POST | Bearer | Pass `name` & `parentId` |
| **Upload File** | `/api/upload/:accountId` | POST | Bearer | Multipart Form: `file` & `folderId` (disk-streamed up to 2GB) |
| **Download/Stream** | `/api/download/:accId/:fileId`| GET | Bearer or `?token=` | Supports `Range`, RFC 5987, ETag 304, and `?preview=1` |
| **Move File** | `/api/files/move` | POST | Bearer | Supports same-drive & cross-drive transfers |
| **Copy File** | `/api/files/copy` | POST | Bearer | Supports same-drive & cross-drive cloning |
| **Share Link** | `/api/share` | POST | Bearer | Returns public URL `/s/:shareId` |
| **Public Download**| `/api/public/download/:shareId`| GET | None | Direct file download |
