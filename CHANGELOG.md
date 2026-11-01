# Cloudyte server changelog

## 2026-11-01 — Phase 3 provider-specific upload execution

- Added account-derived provider validation and session response capability signals (`providerType`, `providerResumable`, `providerCancellable`). Unknown providers and mismatched client provider hints no longer fall through to Google Drive.
- Added durable Google Drive resumable-session handling using persisted session URIs, 308/Range offset reconciliation, native chunk uploads, and transfer-key appProperties for idempotent recovery.
- Added durable OneDrive Graph upload-session handling using persisted `uploadUrl`, `nextExpectedRanges`, 320-KiB-aligned chunks, expired-session replacement, and upstream session cancellation.
- Kept Telegram on GramJS `sendFile`, with server-staging resume and metadata idempotency, while explicitly reporting native provider resumability/cancellation unsupported; zero-byte Telegram documents return a typed unsupported-capability response.
- Hardened staging with byte-verified idempotent chunk replay, per-session chunk fencing, crash-tail truncation, checksum-before-commit, stale completion leases, and safe provider cancellation fencing.
- Added four deterministic provider offset parser tests. `node --check server.ts`, `npm run lint`, and `npm test` pass. Live Google/OneDrive/Telegram credential-backed integration has not been run in this sandbox.
