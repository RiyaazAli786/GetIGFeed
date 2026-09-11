# GetIGFeed Project Context

Last built: 2026-09-10

## What This Repo Is

**GetIGFeed** is a resilient Node.js/Express microservice for fetching Instagram profile media, stories, highlights, posts, and reels across multiple execution tiers:

1. **FeedPilot Android Device Bridge (`src/services/feedPilotBridge.service.js`)**:
   - Direct integration with real Android physical devices running Instagram to bypass datacenter/web scraping blocks.
   - Configured via `FEED_SOURCE_MODE` (`bridge_then_pool`, `android_bridge`, `pool`).
   - Normalizes Android bridge responses into standard `web_profile_info` JSON with `feedpilot_bridge` metadata.

2. **Authenticated Instagram Mobile / Private API (`src/services/instagram.service.js`)**:
   - Accesses `/api/v1/feed/user/<userId>` and `/api/v1/feed/user/<username>/username` via captured session cookies and proxies.
   - Profile resolution engine: Uses TopFollow-style web queries, Polaris hover card GraphQL queries (`PolarisUserHoverCardContentV2Query`), and user info endpoints to guarantee non-zero follower/following/media counts while prioritizing the requested handle over collab posters.
   - Automatic proxy failure detection and rotation (`nextValidPoolProxy`) when session requests hit 401, challenges, or spam blocks.

3. **Multi-Tier Public Fallback Engine (`src/services/feedFallback.service.js`)**:
   - Automated zero-credential failover when private sessions are unavailable, empty, or hit Instagram anti-bot challenges.
   - Sequentially queries fallback providers (`FEED_FALLBACK_PROVIDERS`: `graphql`, then rotating `anonyig`/`fastdl`) and transforms responses into standard `web_profile_info` envelopes.

4. **Third-Party Story & Highlight Scrapers (`src/services/storyFetcher.js`)**:
   - Public sessionless story/highlight extraction (storynavigation.com, anonstories.com, i.theasmn.com).
   - Enriches feed results with top-level `stories`, `highlights`, and detailed `highlight_details` bubbles.

5. **Direct Signed Worker Hubs & GraphQL Modules**:
   - **AnonyIG (`src/anonyig/`)**: Signed HTTP/2 worker hub (`api-wh.anonyig.com`).
   - **FastDL (`src/fastdl/`)**: Signed HTTP/2 worker hub (`api-wh.fastdl.app`).
   - **GraphQL (`src/graphql/`)**: Direct timeline media queries using doc_ids and pool sessions.

6. **Admin Dashboard & Pool Control (`/admin`)**:
   - Web UI for managing AES-256-GCM encrypted Instagram sessions and HTTP/HTTPS/SOCKS5 proxies.
   - Live proxy latency testing, feed preview, story preview, and session import (supporting raw sessionid, cookie strings, or Chrome cookie export JSON arrays).

7. **Audit & Telemetry**:
   - Real-time Telegram API request/response logging middleware (`src/middleware/telegramRequestLogger.js`) with automatic secret redaction.
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
  - `npm run anonyig:chunk` -> Fetches and mirrors AnonyIG signing chunk to disk / B2.
  - `npm run fastdl:chunk` -> Fetches and mirrors FastDL signing chunk to disk / B2.

> [!NOTE]
> On Windows PowerShell environments with restricted script execution policies (`npm.ps1` blocked), always use `npm.cmd` instead of `npm`.

---

## Current Health & Validation

- **Test Suite**: Fully operational via `npm.cmd test`.
- **Test Results** (18/18 passing):
  - FastDL Config, Chunk Sources, VM Sandbox signer, Client methods, and Input normalizers.
  - GraphQL Service exports.
  - Fallback engine username normalizer and trigger conditions (`shouldFallbackForPrivateResult`, `shouldFallbackForError`).
  - Profile resolution count checks (`hasProfileCounts`) and handle match prioritization (`profileFromFeed`).
  - Pool store session parsers (including Chrome cookie export JSON array and cookie strings).
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
      │             ├─► SUCCESS ──► Returns mapped web_profile_info (Header: X-FeedPilot-Bridge: HIT)
      │             └─► FAIL (retryable) ──► (if bridge_then_pool) Fall through to Pool (Header: X-FeedPilot-Bridge: FALLBACK)
      │
      ▼
[3. Auth & Account Resolution]
      ├─ Priority 1: dominatorAccount (legacy object)
      ├─ Priority 2: inline authToken / sessionid / token + proxy / csrfToken
      └─ Priority 3: Encrypted Session & Proxy Pool (Round-Robin)
      │
      ▼
[4. In-Memory Cache Check] (feedCache)
      └─ (if first-page request AND cache enabled AND NOT fresh/bypassCache) ──► Cache HIT
      │
      ▼
[5. Instagram Private Mobile API] (getUserFeed)
      ├─ Builds IGT:2 Bearer Auth + CSRF + CookieJar + Proxy Agent
      ├─ Calls /api/v1/feed/user/<target>/?count=PAGE_COUNT
      ├─ Profile Detail Enrichment:
      │    ├─ If follow counts missing/0:
      │    │    ├─ Polaris Hover Card GraphQL query (PolarisUserHoverCardContentV2Query)
      │    │    ├─ Web api/v1/feed/user/<handle>/username
      │    │    ├─ Web api/v1/users/<pk>/info/
      │    │    └─ OpenGraph HTML scrape fallback
      │    └─ Matches profile candidates to requested handle (prevents collab override)
      │
      ├─► SUCCESS ──► Merges Stories & Highlights (if requested) ──► Response Sent
      │
      └─► FAIL (401 / Unauthorized / Spam Block / Empty Feed):
            │
            ▼
      [6. Proxy Retry with Verified Pool Proxy] (nextValidPoolProxy)
            ├─ Checks next pool proxy with live IP-echo & Instagram reachability probe
            ├─ If reachable: Retries getUserFeed with new proxy (annotates private_retry)
            │
            └─► If still failing (or no auth in pool) AND no maxId:
                  │
                  ▼
            [7. Public Fallback Engine] (getFallbackFeed)
                  ├─ Normalizes handle from input (rejects bare numeric IDs)
                  ├─ Provider 1: GraphQL (no fallback proxy)
                  ├─ Provider 2/3: AnonyIG and FastDL rotate first attempt (pool/provided proxy)
                  └─ Annotates payload with fallback metadata (used, provider, failures)
      │
      ▼
[8. Post-Response Tasks]
      ├─ Asynchronous Feed Logging (src/store/feedLog.js to local disk or B2)
      └─ Telegram Logger dispatches complete response overview
```

---

## FeedPilot Android Device Bridge

The bridge subsystem (`src/services/feedPilotBridge.service.js`) routes requests to an external FeedPilot Android cluster running real Instagram Android app instances.

### Modes (`FEED_SOURCE_MODE` or `FEEDPILOT_BRIDGE_MODE`)
- `bridge_then_pool` (Default): Attempts the Android bridge first. If the bridge returns a retryable error (e.g., 503, 504, `NO_ACTIVE_DEVICE`, `JOB_TIMEOUT`, `DEVICE_OFFLINE`), it seamlessly falls back to the local private API / pool.
- `android_bridge`: Strictly uses the Android bridge. If the bridge fails, returns an error without local fallback.
- `pool`: Bypasses the bridge entirely; uses local session/proxy pool.

### Response Adaptation (`src/utils/mapFeedPilotBridgeResponse.js`)
Normalizes the Android payload into standard Instagram `data.user` (`edge_owner_to_timeline_media`, `edge_followed_by`, `edge_follow`), while adding:
- `feedpilot_bridge`: `{ source: 'android-device', jobId, deviceId, accountUsername, durationMs }`
- Merged `stories`, `highlights`, and `highlight_details` top-level nodes.

---

## Fallback Feed Pipeline (`src/services/feedFallback.service.js`)

When private sessions are banned, rate-limited, challenge-gated, or pool sessions are exhausted:
1. Validates that the target is a public handle (not bare numeric ID).
2. Runs through `FEED_FALLBACK_PROVIDERS` (default: `graphql`, then rotating `anonyig`/`fastdl`).
3. Formats the data into the identical `web_profile_info` structure so client applications do not need custom parsers.
4. Appends a `fallback` metadata block indicating provider used, reason, and any preceding provider failures.

---

## Profile Resolution & Polaris Hover Card Diagnostics

To eliminate the common issue of empty/zero follower counts or collaborator posts masking the profile:
- **Polaris Hover Card Query**: Uses doc_id `27756568060663620` (`PolarisUserHoverCardContentV2Query`) through web GraphQL endpoints with session cookies.
- **Requested Username Priority**: `profileFromFeed()` verifies usernames against the requested handle so collaborator posts in the feed do not hijack the profile identity.
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
2. **Feed Audit Logger (`src/store/feedLog.js`)**:
   - Asynchronously dumps feed request summaries to disk or B2 for debugging and rate limit analysis.
3. **Morgan HTTP Logger**:
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
- `POST /api/user-feed` — Main feed fetcher (supports body params, auth overrides, bridge, fallbacks).
- `GET /api/user-feed` — Query-param variant of feed fetcher.
- `GET /api/user-feed/:userId` — Path-param variant.
- `GET /api/v1/feed/user/:userId/username` — Instagram mobile API compatibility alias.

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
- `GET|POST /api/anonyig/user[/:username]` — AnonyIG user profile.
- `GET|POST /api/anonyig/feed[/:username]` — AnonyIG consolidated feed.
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
| `ADMIN_IDLE_MS` | Number | `30000` | Dashboard session inactivity timeout |
| `FEED_SOURCE_MODE` | String | `bridge_then_pool`| `bridge_then_pool`, `android_bridge`, or `pool` |
| `FEEDPILOT_BRIDGE_URL` | String | Empty | FeedPilot Android bridge base URL |
| `FEEDPILOT_BRIDGE_KEY` | String | Empty | Bridge authentication key (`X-Bridge-Key`) |
| `FEEDPILOT_BRIDGE_TIMEOUT_MS` | Number | `35000` | Timeout for Android device response |
| `FEEDPILOT_BRIDGE_FALLBACK` | Boolean| `true` | Fallback to pool if Android bridge fails |
| `FEED_FALLBACK_PROVIDERS` | String | `graphql,anonyig,fastdl` | Comma-separated fallback order; AnonyIG/FastDL rotate first attempt when both are enabled |
| `FEED_CACHE_DEFAULT` | Boolean| `false` | Enable in-memory TTL caching for 1st-page feeds |
| `CACHE_TTL_MS` | Number | `30000` | Feed memory cache TTL |
| `FEED_INCLUDE_STORIES` | Boolean| `true` | Auto-merge stories/highlights in feed responses |
| `FEED_INCLUDE_HIGHLIGHT_DETAILS`| Boolean | `true` | Auto-expand highlight media bubbles |
| `FEED_HIGHLIGHT_DETAIL_LIMIT` | Number | `0` | Max highlights to expand (0 = all) |
| `TELEGRAM_LOG_ENABLED` | Boolean| `false` | Enable Telegram audit logging |
| `TELEGRAM_BOT_TOKEN` | String | Empty | Telegram Bot API token |
| `TELEGRAM_CHAT_ID` | String | Empty | Destination chat/channel ID |
| `TELEGRAM_LOG_SCOPE` | String | `api` | `api` (/api/* only) or `all` |
| `TELEGRAM_LOG_MAX_BODY` | Number | `1800` | Max characters per request/response body |
| `STORAGE_BACKEND` | String | `file` | `file` or `b2` |
| `B2_BUCKET` / `B2_KEY_ID` / `B2_APPLICATION_KEY` / `B2_ENDPOINT` | String | Empty | Backblaze B2 credentials for cloud persistence |
| `ANONYIG_USE_POOL_PROXY` / `FASTDL_USE_POOL_PROXY` | Boolean| `false` | Tunnel worker hub requests via pool proxies |

---

## Operational Notes & Developer Gotchas

1. **PowerShell Script Policy**:
   - Use `npm.cmd` on Windows when running scripts to bypass PowerShell execution restriction errors (`npm.cmd test`, `npm.cmd run dev`).
2. **Handle vs Numeric ID**:
   - Private API can accept numeric user IDs or handles.
   - Public fallbacks (`anonyig`, `fastdl`) and hover-card resolvers **require** a valid Instagram username handle (`normalizeUsername` rejects purely numeric IDs for fallbacks).
3. **Secret Immutability**:
   - Never change `ENCRYPTION_KEY` in production once pool data has been written; existing entries will fail to decrypt.
4. **Collab Post Protection**:
   - Instagram feed queries often return posts by other users (collaborations/tags). The profile enrichment engine specifically matches user records against the requested handle so external accounts do not overwrite the profile.
5. **Worker Hub Signing Chunks**:
   - The signing chunks for AnonyIG and FastDL are dynamic upstream JS bundles. In environments blocking these hubs (HTTP 451), run `npm run anonyig:chunk` or `npm run fastdl:chunk` in an unblocked environment and mirror the chunk to B2.
