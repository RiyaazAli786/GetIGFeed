# GetIGFeed Project Context

Last built: 2026-11-07

## What This Repo Is

**GetIGFeed** is a resilient Node.js/Express microservice for fetching Instagram profile media, stories, highlights, posts, and reels across multiple execution tiers:

1. **FeedPilot Android Device Bridge (`src/services/feedPilotBridge.service.js`)**:
   - Direct integration with real Android physical devices running Instagram to bypass datacenter/web scraping blocks.
   - Configured via `FEED_SOURCE_MODE` (`bridge_then_pool`, `android_bridge`, `pool`).
   - Normalizes Android bridge responses into standard `web_profile_info` JSON with `feedpilot_bridge` metadata.
   - Enforces strict profile verification (`IG_PROFILE_MISMATCH`) ensuring the returned account matches the requested username.
   - Strict username sanitization (`sanitizeBridgeUsername`): Strips leading `@`, resolves profile URLs to clean handles, rejects post URLs (`/p/...`), reel URLs (`/reel/...`, `/reels/...`), TV URLs (`/tv/...`), story media links, reserved routes, and strings with internal `@` to prevent sending invalid targets to Android automation devices.

2. **Authenticated Instagram Mobile / Private API (`src/services/instagram.service.js`)**:
   - Accesses `/api/v1/feed/user/<userId>` and `/api/v1/feed/user/<username>/username` via captured session cookies and proxies.
   - Profile resolution engine: Uses TopFollow-style web queries, Polaris hover card GraphQL queries (`PolarisUserHoverCardContentV2Query`), and user info endpoints to guarantee non-zero follower/following/media counts while prioritizing the requested handle over collab posters.
   - Automatic proxy failure detection and rotation (`nextValidPoolProxy`) when session requests hit 401, challenges, or spam blocks.

3. **Multi-Tier Public Fallback Engine (`src/services/feedFallback.service.js`)**:
   - Automated zero-credential failover when private sessions are unavailable, empty, or hit Instagram anti-bot challenges.
   - Sequentially queries fallback providers (`FEED_FALLBACK_PROVIDERS`: `graphql`, `igram`, rotating `anonyig`/`fastdl`, and optional `bridge`/`feedpilot`) and transforms responses into standard `web_profile_info` envelopes.
   - Automatic loop prevention: Supports `excludeProviders` and `failedSource` so failing upstream sources do not redundantly retry themselves.
   - Granular diagnostic aggregation: Collects all attempted provider failures into an error `failures` array.

4. **Third-Party Story & Highlight Scrapers (`src/services/storyFetcher.js`, `src/services/instagramStory.service.js`)**:
   - Public sessionless story/highlight extraction (storynavigation.com, anonstories.com, i.theasmn.com).
   - Enriches feed results with top-level `stories`, `highlights`, and detailed `highlight_details` bubbles.
   - Provides resilient sessionless numeric user ID resolution for GraphQL queries even when Instagram blocks datacenter web profile queries.

5. **Direct Signed Worker Hubs & GraphQL Modules**:
   - **GraphQL (`src/graphql/service.js`)**: Direct timeline media queries using doc_id `7950326061742207` and pool sessions, powered by a 5-strategy user ID resolution pipeline and numeric ID fast-path (`numericUserId`).
   - **IGram (`src/igram/`)**: Profile and highlight story viewer integration (`api-wh.igram.world`).
   - **AnonyIG (`src/anonyig/`)**: Signed HTTP/2 worker hub (`api-wh.anonyig.com`) with per-request proxy/provider overrides.
   - **FastDL (`src/fastdl/`)**: Signed HTTP/2 worker hub (`api-wh.fastdl.app`) with per-request proxy/provider overrides.

6. **Admin Dashboard & Pool Control (`/admin`)**:
   - Web UI for managing AES-256-GCM encrypted Instagram sessions and HTTP/HTTPS/SOCKS5 proxies.
   - Live proxy latency testing, feed preview, story preview, and session import (supporting raw sessionid, cookie strings, or Chrome cookie export JSON arrays).

7. **Audit & Telemetry**:
   - Real-time Telegram API request/response and feed resolution logging middleware (`src/middleware/telegramRequestLogger.js`, `src/utils/feedResolution.js`) with automatic secret redaction.
   - Structured API error formatting (`src/middleware/errorHandler.js`) returning error codes and provider failure traces.
   - Disk/B2 feed logging (`src/store/feedLog.js`).

---

## Runtime & Tooling

- **Language / Runtime**: CommonJS Node.js (`node >= 18.0.0`).
- **Web Framework**: Express 4.21.
- **Entry Point**: `src/index.js` (bootstrapper, pool warmup, graceful shutdown).
- **Express Wiring**: `src/app.js`.
- **Primary Commands**:
  - `npm start` -> `node src/index.js`
  - `npm run dev` -> `nodemon src/index.js`
  - `npm.cmd test` -> `node --test` (Runs built-in Node test suite)
  - `npm.cmd run test:hover-card -- <handle>` -> Diagnostics CLI for Polaris hover card GraphQL profile resolution.
  - `npm run igram:chunk` -> Fetches and mirrors IGram signing chunk.
  - `npm run anonyig:chunk` -> Fetches and mirrors AnonyIG signing chunk to disk / B2.
  - `npm run fastdl:chunk` -> Fetches and mirrors FastDL signing chunk to disk / B2.

> [!NOTE]
> On Windows PowerShell environments with restricted script execution policies (`npm.ps1` blocked), always use `npm.cmd` instead of `npm`.

---

## Current Health & Validation

- **Test Suite**: Fully operational via `npm.cmd test`.
- **Test Results** (44/44 passing):
  - FastDL Config, Chunk Sources, VM Sandbox signer, Client methods, converted feed, and Input normalizers.
  - GraphQL Service exports and clean web headers (no mobile Authorization leak).
  - Numeric user ID resolution (`resolveUserId`) fast-path.
  - IGram configuration, client methods, URL/handle/highlight parsers, and feed conversion.
  - Feed resolution formatting (`formatFeedResolutionText`, res.locals tracking, and Telegram message integration).
  - Fallback engine username normalizer, ordered providers (preserving order, rotating workers, and excluding failing sources), and trigger conditions (`shouldFallbackForPrivateResult`, `shouldFallbackForError`).
  - FeedPilot Bridge configuration, strict boolean options, retryable empty/502 handling, and profile mismatch detection.
  - Profile resolution count checks (`hasProfileCounts`) and handle match prioritization (`profileFromFeed`).
  - ExceptionUser storage, deduplication, search/filter, pagination, updating, removal, and pool update survival (`src/store/exceptionUserStore.test.js`).
  - Pool store session parsers (Chrome cookie export JSON array, object.cookies, JSON strings).
- **Dependencies**: All production dependencies (`axios`, `@aws-sdk/client-s3`, `tough-cookie`, `http-cookie-agent`, `https-proxy-agent`, `archiver`, etc.) are installed and validated.

---

## Request Flow & Multi-Tier Resolution Pipeline

Primary entry point: `POST /api/user-feed` or `GET /api/user-feed[/:userId]`

```
Client Request
      │
      ▼
[1. Telegram Request Logger] ──► Captures timing, redacted headers/body (if enabled)
      │
      ▼
[2. Bridge Mode Evaluation] (FEED_SOURCE_MODE: bridge_then_pool | android_bridge | pool)
      ├─► (if android_bridge or bridge_then_pool AND no maxId)
      │      └─► FeedPilot Android Bridge (/api/bridge/feed)
      │             ├─► SUCCESS & Handle Match ──► Returns mapped web_profile_info (Header: X-FeedPilot-Bridge: HIT)
      │             ├─► IG_PROFILE_MISMATCH ──► Marks retryable ──► Falls through to Pool (Header: X-FeedPilot-Bridge: FALLBACK)
      │             └─► FAIL (retryable) ──► (if bridge_then_pool) Falls through to Pool (Header: X-FeedPilot-Bridge: FALLBACK)
      │
      ▼
[3. Auth & Account Resolution]
      ├─ Priority 1: dominatorAccount (legacy object)
      ├─ Priority 2: inline authToken / sessionid / token + proxy / csrfToken
      └─ Priority 3: Encrypted Session & Proxy Pool (Round-Robin)
      │
      ▼
[4. Primary Fetch: GraphQL or Private Mobile API]
      ├─ Branch A: GraphQL doc_id 7950326061742207 (USER_FEED_PRIMARY_SOURCE=graphql, default)
      │    ├─ Resolves numeric userId via 5-strategy resolver (or uses fast-path numericUserId)
      │    └─ Executes GraphQL query with session cookies + web CSRF/claim headers
      │
      ├─ Branch B: Private Mobile API (/api/v1/feed/user/<target>/)
      │    ├─ Builds IGT:2 Bearer Auth + CSRF + CookieJar + Proxy Agent
      │    └─ Profile Detail Enrichment:
      │         ├─ If follow counts missing/0:
      │         │    ├─ Polaris Hover Card GraphQL query (PolarisUserHoverCardContentV2Query)
      │         │    ├─ Web api/v1/feed/user/<handle>/username
      │         │    ├─ Web api/v1/users/<pk>/info/
      │         │    └─ OpenGraph HTML scrape fallback
      │         └─ Matches profile candidates to requested handle (prevents collab override)
      │
      ├─► SUCCESS ──► Merges Stories & Highlights (if requested) ──► Response Sent
      │
      └─► FAIL (401 / Unauthorized / Spam Block / Empty Feed):
            │
            ▼
      [5. Proxy Retry with Verified Pool Proxy] (nextValidPoolProxy)
            ├─ Checks next pool proxy with live IP-echo & Instagram reachability probe
            ├─ If reachable: Retries getUserFeed with new proxy (annotates private_retry)
            │
            └─► If still failing (or no auth in pool) AND no maxId:
                  │
                  ▼
            [6. Multi-Tier Public Fallback Engine] (getFallbackFeed)
                  ├─ Normalizes handle from input (rejects bare numeric IDs)
                  ├─ Excludes failing source to prevent redundant self-calls
                  ├─ Provider Sequence: FEED_FALLBACK_PROVIDERS (default: graphql, igram, rotating anonyig/fastdl)
                  ├─ Captures all provider failures into failures array
                  └─ If all fail: Returns HTTP 502 with full diagnostic failure breakdown
      │
      ▼
[7. Post-Response Tasks]
      ├─ Asynchronous Feed Logging (src/store/feedLog.js to local disk or B2)
      └─ Telegram Logger dispatches complete response overview
```

---

## 5-Strategy User ID Resolution Pipeline (`src/graphql/service.js`)

When querying Instagram GraphQL timeline media, a numeric user ID (`id`) is strictly required. `resolveUserId(username)` executes up to 5 progressive strategies:

1. **Strategy 1: Public `web_profile_info` Native HTTPS**: Lightweight native Node fetch (zero session, avoids axios interceptor conflicts).
2. **Strategy 2: AnonyIG `getUser`**: High-fidelity signed HTTP/2 worker hub query returning numeric `id`.
3. **Strategy 3: Pool Client `web_profile_info` with Auth**: Authenticated web query using active session pool cookies and claim headers.
4. **Strategy 4: Third-Party Story Viewer (`fetchMedia`)**: Uses sessionless profile extraction via storynavigation / ASMN. Highly effective on datacenter IPs where Instagram blocks web profile endpoints.
5. **Strategy 5: FastDL `userInfo`**: FastDL worker hub profile inspection returning numeric user PK.
- **Fast-Path Bypass**: Passing `numericUserId` or `userIdNumeric` in query/body skips all external network resolution calls immediately.

---

## FeedPilot Android Device Bridge

The bridge subsystem (`src/services/feedPilotBridge.service.js`) routes requests to an external FeedPilot Android cluster running real Instagram Android app instances.

### Modes (`FEED_SOURCE_MODE` or `FEEDPILOT_BRIDGE_MODE`)
- `bridge_then_pool` (Default): Attempts the Android bridge first. If the bridge returns a retryable error (e.g., 502, 503, 504, `NO_ACTIVE_DEVICE`, `NO_ACTIVE_SESSION`, `JOB_TIMEOUT`, `DEVICE_OFFLINE`, `IG_EMPTY_FEED`, `IG_PROFILE_MISMATCH`), it seamlessly falls back to the local private API / pool.
- `android_bridge`: Strictly uses the Android bridge. If the bridge fails, returns an error without local fallback.
- `pool`: Bypasses the bridge entirely; uses local session/proxy pool.

### Response Adaptation & Safety
- **Profile Mismatch Guard**: Verifies that the returned account username matches the requested username. If an Android device served another user's feed, it is classified as `IG_PROFILE_MISMATCH` and retried through pool/fallback tiers.
- **Normalization (`src/utils/mapFeedPilotBridgeResponse.js`)**: Normalizes Android payload into standard Instagram `data.user` (`edge_owner_to_timeline_media`, `edge_followed_by`, `edge_follow`), while adding:
  - `feedpilot_bridge`: `{ source: 'android-device', jobId, deviceId, accountUsername, durationMs }`
  - Merged `stories`, `highlights`, and `highlight_details` top-level nodes.

---

## Fallback Feed Pipeline (`src/services/feedFallback.service.js`)

When private sessions are banned, rate-limited, challenge-gated, or pool sessions are exhausted:
1. Validates that the target is a public handle (not bare numeric ID).
2. Excludes `failedSource` and any specified `excludeProviders` to prevent infinite loops.
3. Queries providers according to `FEED_FALLBACK_PROVIDERS` (supported: `graphql`, `igram`, `anonyig`, `fastdl`, `bridge`, `feedpilot`).
4. Alternates worker hubs (`anonyig`, `fastdl`) on consecutive requests for even load distribution.
5. Normalizes responses into the identical `web_profile_info` contract.
6. Upon complete failure across all providers, raises an HTTP 502 error annotated with `failures` detailing the exact status and error message from each attempted provider.

---

## Profile Resolution & Polaris Hover Card Diagnostics

To eliminate empty/zero follower counts or collaborator posts masking the profile:
- **Polaris Hover Card Query**: Uses doc_id `27756568060663620` (`PolarisUserHoverCardContentV2Query`) through web GraphQL endpoints with session cookies.
- **Requested Username Priority**: `profileFromFeed()` verifies usernames against the requested handle so collaborator posts in the feed do not hijack profile identity.
- **Diagnostics Script**: Run `npm.cmd run test:hover-card -- <username-or-id> [--pool | sessionfile.json]` to inspect raw hover card resolution and verify session compatibility.

---

## Storage, Pool Management & Credentials

- **Store Module**: `src/store/poolStore.js`
- **Backend Switcher**: `src/store/poolBackend.js`
  - `STORAGE_BACKEND=file`: Stored in `${DATA_DIR}/pool.json` (default `./data/pool.json`).
  - `STORAGE_BACKEND=b2`: Synchronized to Backblaze B2 bucket (stateless cloud containers).
- **Security**:
  - All sensitive fields (`sessionid`, `proxyPassword`, etc.) are encrypted at rest using AES-256-GCM via `src/utils/crypto.js` and `ENCRYPTION_KEY`.
  - Admin list endpoints return masked tokens (e.g. `****1a2b`). Decryption occurs only in memory when constructing outgoing HTTP agents.
- **Session Formats Supported**:
  - Raw sessionid string.
  - Semicolon-separated cookie header string (`sessionid=...; csrftoken=...; ds_user_id=...`).
  - Chrome / browser extension cookie export JSON array (`[{ name: 'sessionid', value: '...' }, ...]`).
  - Standard JSON object (`{ sessionid, csrftoken, dsUserId, label }`).

---

## Telemetry, Audit & Logging

1. **Telegram API Request Logger (`src/middleware/telegramRequestLogger.js`)**:
   - Configurable via `TELEGRAM_LOG_ENABLED=true`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`.
   - Captures HTTP method, URL, status code, latency, IP, redacted request headers/body, and truncated response payload.
   - Strictly redacts passwords, session tokens, CSRF tokens, authorization headers, and cookies.
   - Respects Telegram's 4096-character limit by splitting large payloads into chunks.
2. **Global Error Handler (`src/middleware/errorHandler.js`)**:
   - Returns structured JSON `{ success: false, error: message, failures: [...], code: "..." }`.
   - Preserves diagnostic error arrays from multi-provider fallback cascades.
3. **Feed Audit Logger (`src/store/feedLog.js`)**:
   - Asynchronously dumps feed request summaries to disk or B2 for debugging and rate limit analysis.
4. **Morgan HTTP Logger**:
   - Standard stdout logging (`combined` in production, `dev` in development).

---

## Complete API Surface

### Health & Admin UI
- `GET /health` — Service liveness check.
- `GET /admin` — Administrative web dashboard.
- `GET /admin/status` — Real-time pool metrics and configuration summary.
- `POST /admin/login` — Authenticates dashboard passcode and issues sliding admin token.
- `GET /instagram-view.html` — Standalone Instagram feed and story viewer.

### Feed Endpoints
- `POST /api/user-feed` — Main feed fetcher (supports body params, auth overrides, bridge, fallbacks, `providers`, `proxy`, `numericUserId`).
- `GET /api/user-feed` — Query-param variant of feed fetcher.
- `GET /api/user-feed/:userId` — Path-param variant.
- `GET /api/v1/feed/user/:userId/username` — Instagram mobile API compatibility alias.

### Exception User Management
- `GET /api/exception-users` — List exception users (supports `search`, `page`, `pageSize`) or register if `?username=` is provided.
- `POST /api/exception-users` — Register a username in the persistent ExceptionUser list.
- `PUT /api/exception-users/:username` — Update / rename an existing exception user.
- `DELETE /api/exception-users/:username` — Remove a username from the persistent ExceptionUser list.

### Session & Proxy Pool Management
- `GET /api/sessions` — List all pool sessions (masked secrets).
- `POST /api/sessions` — Add sessions (accepts single strings, cookie strings, Chrome JSON arrays, or objects).
- `DELETE /api/sessions/:id` — Remove a session.
- `DELETE /api/sessions` — Clear all sessions.
- `GET /api/proxies` — List all proxies (masked passwords).
- `POST /api/proxies` — Add proxies (`host:port:user:pass` or object).
- `DELETE /api/proxies/:id` — Remove a proxy.
- `DELETE /api/proxies` — Clear all proxies.
- `POST /admin/proxies/:id/check` — Live connectivity and latency test for a proxy.

### Stories & Media Downloads
- `GET|POST /api/instagram/search[/:username]` — Sessionless stories & highlights lookup.
- `GET|POST /api/instagram/stories[/:username]` — Stories only.
- `GET|POST /api/instagram/story[/:username]` — Story alias.
- `GET /api/instagram/highlights/:highlightId` — Individual highlight items.
- `GET /api/instagram/media?url=...` — Proxies media asset preview (with allowlist validation).
- `POST /api/instagram/download/zip` — Direct stream zip archive.
- `POST /api/instagram/download/zip/start` — Starts asynchronous background zip packaging job.
- `GET /api/instagram/download/zip/:jobId/events` — Server-Sent Events (SSE) progress stream for zip jobs.
- `GET /api/instagram/download/zip/:jobId/file` — Downloads generated zip archive.

### Third-Party Worker Hubs & Direct GraphQL
- `GET|POST /api/igram[/:username]` — IGram single media or profile feed resolution.
- `GET /api/igram/highlights/:highlightId` — IGram highlight story detail.
- `GET /api/igram/status` — IGram worker hub health.
- `GET|POST /api/anonyig/user[/:username]` — AnonyIG user profile.
- `GET|POST /api/anonyig/feed[/:username]` — AnonyIG consolidated feed (accepts `proxy`, `providers`).
- `GET /api/anonyig/posts[/:username]` — AnonyIG timeline posts.
- `GET /api/anonyig/reels[/:username]` — AnonyIG reels.
- `GET /api/anonyig/stories[/:username]` — AnonyIG stories.
- `GET /api/anonyig/highlights[/:username]` — AnonyIG highlights.
- `GET /api/anonyig/status` — AnonyIG worker hub health.
- `GET|POST /api/fastdl[/:username]` — FastDL single media or profile feed resolution.
- `GET /api/fastdl/highlights/:highlightId` — FastDL highlight detail.
- `GET /api/fastdl/status` — FastDL worker hub health.
- `GET|POST /api/graphql[/:username]` — Direct Instagram timeline query using pool session.

---

## Configuration Reference (`.env`)

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | Number | `3000` | HTTP port |
| `NODE_ENV` | String | `development` | `development` or `production` |
| `DATA_DIR` | String | `./data` | Local directory for logs, token cache, and file pool |
| `ENCRYPTION_KEY` | String | *Required* | 32-byte AES-256-GCM encryption key for secrets |
| `ADMIN_PASSCODE` | String | *Required* | Passcode to access `/admin` dashboard |
| `ADMIN_IDLE_MS` | Number | `300000` | Dashboard session inactivity timeout |
| `USER_FEED_PRIMARY_SOURCE` | String | `graphql` | Primary source for user-feed: `graphql` or `private` |
| `FEED_SOURCE_MODE` | String | `bridge_then_pool`| `bridge_then_pool`, `android_bridge`, or `pool` |
| `FEEDPILOT_BRIDGE_URL` | String | Empty | FeedPilot Android bridge base URL (`/api/bridge/feed`) |
| `FEEDPILOT_BRIDGE_KEY` | String | Empty | Bridge authentication key (`X-Bridge-Key`) |
| `FEEDPILOT_BRIDGE_TIMEOUT_MS` | Number | `35000` | Timeout for Android device response |
| `FEEDPILOT_BRIDGE_FALLBACK` | Boolean| `true` | Fallback to pool if Android bridge fails |
| `FEED_FALLBACK_PROVIDERS` | String | `graphql,igram,anonyig,fastdl` | Comma-separated fallback order (supports `bridge`/`feedpilot`) |
| `USER_FEED_IGRAM_FALLBACK` | Boolean| `true` | Enable/disable IGram in user feed fallback pipeline |
| `USER_FEED_HUB_FALLBACK` | Boolean| `true` | Enable/disable AnonyIG/FastDL worker hubs in fallback |
| `FEED_INCLUDE_STORIES` | Boolean| `true` | Auto-merge stories/highlights in feed responses |
| `FEED_INCLUDE_HIGHLIGHT_DETAILS`| Boolean | `true` | Auto-expand highlight media bubbles |
| `FEED_HIGHLIGHT_DETAIL_LIMIT` | Number | `0` | Max highlights to expand (0 = all) |
| `TELEGRAM_LOG_ENABLED` | Boolean| `false` | Enable Telegram audit logging |
| `TELEGRAM_FEED_LOG_ENABLED` | Boolean| `false` | Enable Telegram audit logging specifically for feed routes |
| `TELEGRAM_BOT_TOKEN` | String | Empty | Telegram Bot API token |
| `TELEGRAM_CHAT_ID` | String | Empty | Destination chat/channel ID |
| `TELEGRAM_LOG_SCOPE` | String | `api` | `api` (/api/* only) or `all` |
| `TELEGRAM_LOG_MAX_BODY` | Number | `1800` | Max characters per request/response body |
| `ANONYIG_PROXY` | String | Empty | HTTP proxy URL or `host:port:user:pass` for AnonyIG |
| `ANONYIG_USE_POOL_PROXY` | Boolean| `false` | Tunnel AnonyIG hub requests through proxy pool |
| `FASTDL_PROXY` | String | Empty | HTTP proxy URL or `host:port:user:pass` for FastDL |
| `FASTDL_USE_POOL_PROXY` | Boolean| `false` | Tunnel FastDL hub requests through proxy pool |
| `IGRAM_WORKER_HUB` | String | `https://api-wh.igram.world` | IGram worker hub API endpoint |
| `IGRAM_PROXY` | String | Empty | HTTP proxy URL or `host:port:user:pass` for IGram |
| `IGRAM_USE_POOL_PROXY` | Boolean| `false` | Tunnel IGram hub requests through proxy pool |
| `STORAGE_BACKEND` | String | `file` | `file` or `b2` |
| `B2_BUCKET` / `B2_KEY_ID` / `B2_APPLICATION_KEY` / `B2_ENDPOINT` | String | Empty | Backblaze B2 credentials for cloud persistence |

---

## Operational Notes & Developer Gotchas

1. **PowerShell Script Policy**:
   - Use `npm.cmd` on Windows when running scripts to bypass PowerShell execution restriction errors (`npm.cmd test`, `npm.cmd run dev`).
2. **Handle vs Numeric ID**:
   - Private API and GraphQL can accept numeric user IDs or handles.
   - When a numeric user ID is already available, supply `numericUserId` or `userIdNumeric` to fast-path directly and eliminate resolution overhead.
   - Public fallbacks (`anonyig`, `fastdl`) and hover-card resolvers **require** a valid Instagram username handle (`normalizeUsername` rejects purely numeric IDs for fallbacks).
3. **Cloudflare Turnstile on Worker Hubs**:
   - Third-party worker hubs (`api-wh.anonyig.com`, `api-wh.fastdl.app`) enforce Cloudflare Turnstile bot challenges against datacenter ASNs (AWS, Render, Hetzner, etc.), returning HTTP 422 `CAPTCHA_REQUIRED`.
   - Datacenter-based proxies (even if located in commercial IP hubs like Ashburn, VA) are challenged. True **residential** or **mobile** proxies (`ANONYIG_PROXY`, `FASTDL_PROXY`, or `USE_POOL_PROXY=true` with residential IPs in the pool) are required to clear Turnstile.
4. **FeedPilot Android Device Availability**:
   - FeedPilot Bridge requires at least 1 online Android phone (`onlineDevices >= 1`). If devices are offline, the bridge returns `NO_ACTIVE_SESSION`, causing GetIGFeed to fall back to pool sessions and public fallbacks.
5. **Secret Immutability**:
   - Never change `ENCRYPTION_KEY` in production once pool data has been written; existing entries will fail to decrypt.
6. **Collab Post Protection**:
   - Instagram feed queries often return posts by other users (collaborations/tags). The profile enrichment engine specifically matches user records against the requested handle so external accounts do not overwrite the profile.
7. **Worker Hub Signing Chunks**:
   - The signing chunks for AnonyIG and FastDL are dynamic upstream JS bundles. In environments blocking these hubs (HTTP 451), run `npm run anonyig:chunk` or `npm run fastdl:chunk` in an unblocked environment and mirror the chunk to B2.

## ExceptionUser Routing & Management

The persistent ExceptionUser system ensures high-priority accounts bypass default mode settings and always prioritize the FeedPilot Android Bridge.

### Registration
- `POST /api/exception-users` with JSON `{ "username": "example.user" }`
- `GET /api/exception-users?username=example.user` (legacy GET registration)

Returns HTTP 201 when added:
```json
{ "success": true, "username": "example.user", "added": true, "userExist": false, "status": "added", "feedSourceMode": "bridge_then_pool" }
```

Returns HTTP 200 if already registered (idempotent):
```json
{ "success": true, "username": "example.user", "added": false, "userExist": true, "status": "exists", "feedSourceMode": "bridge_then_pool" }
```

### Listing (Search & Pagination)
- `GET /api/exception-users` (when `username` parameter is omitted)
- Query parameters:
  - `search` (string, optional): Case-insensitive substring filter (trimmed, leading `@` removed).
  - `page` (integer, optional): 1-based page index (defaults to `1`).
  - `pageSize` (integer, optional): Page size (defaults to `25`, clamped between `1` and `100`).

Returns HTTP 200:
```json
{
  "success": true,
  "users": ["example.user"],
  "total": 1,
  "page": 1,
  "pageSize": 25,
  "pages": 1
}
```

### Update / Rename
- `PUT /api/exception-users/:username` with JSON `{ "username": "new_handle" }`
- Returns HTTP 200:
  ```json
  { "success": true, "username": "new_handle" }
  ```
- Returns HTTP 400 if target or new handle is invalid.
- Returns HTTP 404 if target user is not in the list.
- Returns HTTP 409 if new handle already exists in the list.

### Removal
- `DELETE /api/exception-users/:username`
- Returns HTTP 200:
  ```json
  { "success": true, "username": "example.user", "deleted": true }
  ```
- Returns HTTP 400 if username is invalid.
- Returns HTTP 404 if user is not in the list.

### Feed Execution & Persistence Semantics
- **Priority Routing**: Requests to `POST /api/user-feed` or `GET /api/user-feed/:userId` matching any registered exception user automatically execute with `bridge_then_pool` regardless of `FEED_SOURCE_MODE` or bridge toggles. The bridge is attempted first; retryable failures automatically fail over to pool GraphQL / private API / fallback tiers. Other usernames follow environment configuration. Requests with `maxId`/`max_id` retain pagination behavior and skip the bridge.
- **Normalization**: Usernames are trimmed, leading `@` is stripped, and matching is case-insensitive. Numeric IDs return HTTP 400 (for numeric `userId` feed requests, provide `username` or `handle`).
- **Concurrency & Cache**: Mutations (`add`, `update`, `remove`) are serialized per-process via chained promises (`pendingAdd`). Reads (`list`, `has`) wait for pending mutations. All responses send `Cache-Control: no-store`.
- **Storage**: Persisted under `exceptionUsers` in the pool storage (`data/pool.json` or B2 object) and survives restarts without modifying existing sessions or proxies.
