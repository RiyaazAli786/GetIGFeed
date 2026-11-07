# GetIGFeed — Complete Workspace & Architecture Context

> Living reference for the entire GetIGFeed repository. Last updated on 2026-11-07.
> Companion docs: [Master.md](file:///c:/CoreProjects/GetIGFeed/Master.md) (API Reference), [API.md](file:///c:/CoreProjects/GetIGFeed/API.md) (Detailed API Specification), [Run.md](file:///c:/CoreProjects/GetIGFeed/Run.md) (Operational Guide), [DEPLOY.md](file:///c:/CoreProjects/GetIGFeed/DEPLOY.md) (Render Deployment), [DEPLOY_VPS.md](file:///c:/CoreProjects/GetIGFeed/DEPLOY_VPS.md) (VPS & Docker Deployment), [PROJECT_CONTEXT.md](file:///c:/CoreProjects/GetIGFeed/PROJECT_CONTEXT.md) (Project Context).

---

## Executive Summary

**GetIGFeed** is a high-performance, resilient Node.js / Express API microservice and multi-tiered scraping engine designed to fetch Instagram user feeds, stories, highlights, posts, reels, and media assets. It acts as an intelligent orchestration layer across:

1. **FeedPilot Android Device Bridge**: Direct physical Android device execution for anti-bot bypass with `IG_PROFILE_MISMATCH` account validation.
2. **Instagram Private Mobile API**: Direct `/api/v1/` mobile endpoint fetching with session cookie jars and rotating proxies.
3. **Polaris GraphQL Hover Card Enrichment**: Resolves complete profile counts (followers/following) while preserving the requested user handle against collaborator post overrides.
4. **5-Strategy Numeric User ID Resolver**: Resolves handles to numeric IDs via native HTTPS `web_profile_info`, AnonyIG `getUser`, pool client web queries, sessionless story viewers (`storynavigation`/`theasmn`), and FastDL `userInfo`, alongside a fast-path `numericUserId` bypass.
5. **Automated Session & Proxy Pool**: Round-robin rotation, proxy validation, automated failover, and dual persistence backends (local filesystem or Backblaze B2). Supports Chrome cookie export JSON arrays.
6. **Multi-Tier Public Fallback Engine**: Automatic failover to public providers (`graphql`, `igram`, `anonyig`, `fastdl`, `bridge`) with loop exclusion (`excludeProviders`) and comprehensive error aggregation (`failures` array in 502 responses).
7. **Third-Party Story Platforms & Signed HTTP/2 Worker Hubs**: IGram, AnonyIG, and FastDL signed worker hub clients with per-request proxy routing.
8. **Telegram Telemetry & Audit**: Real-time request, response, and feed resolution logging to Telegram with sensitive credential masking.

---

## 1. System Architecture

```
                                 ┌────────────────────────────────────────────────────────┐
                                 │                Client / Web Dashboard                  │
                                 │            (Browser / API Consumer / Admin)            │
                                 └───────────────────────────┬────────────────────────────┘
                                                             │
                                                             │ REST HTTP Requests (JSON)
                                                             │ Bearer Admin Token / Headers
                                                             ▼
                                 ┌────────────────────────────────────────────────────────┐
                                 │               Express 4 Server (src/app.js)            │
                                 │       Morgan + Telegram Request Logger + Error Handler │
                                 └───────────────┬─────────────────────────┬──────────────┘
                                                 │                         │
                 ┌───────────────────────────────┴──────────┐   ┌──────────┴──────────────────────────────┐
                 │ Public API Routes                        │   │ Admin Gated Routes                      │
                 │ (/api/user-feed, /api/instagram, etc.)   │   │ (/admin/* via passcode session)         │
                 └───────────────┬──────────────────────────┘   └──────────┬──────────────────────────────┘
                                 │                                         │
 ┌───────────────────────────────┼───────────────────────────────┬─────────┴──────────────────────────────┐
 │                               │                               │                                        │
 ▼                               ▼                               ▼                                        ▼
┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────────────┐
│ FeedPilot Bridge     │ │ Private Mobile API   │ │ Multi-Tier Fallback  │ │ Session & Proxy Pool Store   │
│ (src/services/       │ │ & GraphQL Service    │ │ Engine (IGram,       │ │ (src/store/poolStore.js)     │
│  feedPilotBridge)    │ │ (src/services/       │ │  AnonyIG, FastDL,    │ │ Encrypted AES-256-GCM        │
│                      │ │  instagram, graphql) │ │  GraphQL, Bridge)    │ │                              │
└──────────┬───────────┘ └──────────┬───────────┘ └──────────┬───────────┘ └──────────────┬───────────────┘
           │                        │                        │                            │
           │ X-Bridge-Key Auth      │ Proxy & Cookie Agent   │ HTTP/2 Signed Headers      │ Persistence Layer
           ▼                        ▼                        ▼                            ▼
┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────────────┐
│ FeedPilot Android    │ │ Instagram Mobile &   │ │ igram.world,         │ │ Local JSON (data/pool.json)  │
│ Device Hub Servers   │ │ Polaris Hover Card   │ │ anonyig & fastdl     │ │ or Backblaze B2 Object Bucket│
└──────────────────────┘ └──────────────────────┘ └──────────────────────┘ └──────────────────────────────┘
```

---

## 2. Workspace & Directory Structure

```
GetIGFeed/
├── .github/                  # Automated workflows and deployment actions
├── deploy/                   # Production Nginx configs & systemd unit files
├── scripts/
│   └── polaris-hover-card-check.js # Polaris hover card profile resolution check CLI
├── src/                      # Microservice source code
│   ├── index.js              # Server bootstrapper, pool warmup & graceful shutdown
│   ├── app.js                # Express app middleware setup and route binding
│   ├── routes/               # API route definitions
│   │   ├── userFeed.routes.js   # /api/user-feed
│   │   ├── story.routes.js      # /api/instagram (Stories & Highlights)
│   │   ├── pool.routes.js       # /api/sessions & /api/proxies
│   │   ├── admin.routes.js      # /admin routes
│   │   ├── authToken.routes.js  # /api/auth-token
│   │   └── health.routes.js     # /health
│   ├── controllers/          # Request handlers and response envelope formatting
│   │   ├── userFeed.controller.js
│   │   ├── story.controller.js
│   │   ├── pool.controller.js
│   │   ├── admin.controller.js
│   │   └── authToken.controller.js
│   ├── services/             # Core scraping logic, API clients & fallback engines
│   │   ├── feedPilotBridge.service.js # FeedPilot Android device bridge client
│   │   ├── feedFallback.service.js    # Public provider fallback engine
│   │   ├── instagram.service.js       # Private Mobile API & Polaris hover card enricher
│   │   ├── instagramStory.service.js  # Web story & highlight fetcher
│   │   ├── storyFetcher.js            # Third-party story viewer scrapers
│   │   ├── download.service.js        # Multi-file zip archiver & SSE progress stream
│   │   ├── proxyCheck.js              # Proxy connectivity & latency tester
│   │   ├── adminAuth.js               # Passcode hashing & sliding window admin token
│   │   ├── browserFallback.js         # Headless browser fallback client
│   │   ├── feedStoryMerge.js          # Merges feed timeline with stories & highlights
│   │   └── webParameter.js            # Query signature generator for web API calls
│   ├── igram/                # IGram worker hub subsystem & feed conversion
│   ├── anonyig/              # Anonyig worker hub subsystem (HTTP/2 transport)
│   ├── fastdl/               # FastDL.app worker hub subsystem
│   ├── graphql/              # Direct Instagram GraphQL timeline module & 5-tier ID resolver
│   ├── store/                # In-memory storage & persistence engines
│   │   ├── poolStore.js               # Round-robin session & proxy pool manager
│   │   ├── poolBackend.js             # File system vs Backblaze B2 backend switcher
│   │   ├── tokenStore.js              # Session token cache
│   │   ├── exceptionUserStore.js      # Persistent ExceptionUser list storage & CRUD
│   │   └── feedLog.js                 # Audit logger for incoming feed requests
│   ├── parsers/              # Response payload normalization
│   ├── middleware/           # Express middlewares
│   │   ├── errorHandler.js            # Global error handler & failure serializer
│   │   └── telegramRequestLogger.js   # Audit logger dispatching to Telegram
│   ├── utils/                # Utilities
│   │   ├── mapFeedPilotBridgeResponse.js # Mappers for FeedPilot Android bridge payloads
│   │   ├── mapFeedToWebProfile.js        # Mappers for Instagram mobile API payloads
│   │   ├── feedResolution.js          # Resolution metadata tracker & formatter
│   │   ├── cache.js                   # In-memory TTL cache (deprecated; direct fetch used)
│   │   ├── crypto.js                  # AES-256-GCM encryption & decryption
│   │   └── httpFetch.js               # Low-level fetch wrapper
│   └── public/               # Admin web dashboard HTML & assets
├── Dockerfile                # Multi-stage production container definition
├── docker-compose.yml        # Docker composition setup with health checks
├── render.yaml               # Render cloud platform deployment specification
├── Master.md                 # Complete Master API documentation
├── API.md                    # In-depth API endpoint catalog
├── Run.md                    # Local setup and developer execution instructions
├── DEPLOY.md                 # Render deployment guide
├── DEPLOY_VPS.md             # VPS Docker & Nginx hosting instructions
├── README.md                 # Repository introduction & quick start
├── PROJECT_CONTEXT.md        # Comprehensive technical architecture context
├── package.json              # Dependencies and script commands
└── .env.example              # Template for environment configuration
```

---

## 3. Core Engine & Key Subsystems

### 3.1 FeedPilot Android Device Bridge (`src/services/feedPilotBridge.service.js`)
* Bridges feed requests to external real Android hardware devices running Instagram.
* Governed by `FEED_SOURCE_MODE` (`bridge_then_pool`, `android_bridge`, `pool`).
* Automatically falls back to local pool/session scraping upon retryable errors (502, 503, 504, `NO_ACTIVE_DEVICE`, `NO_ACTIVE_SESSION`, `DEVICE_OFFLINE`, `IG_EMPTY_FEED`).
* **Handle Mismatch Guard**: Verifies that the returned account username matches the requested username. If an Android device served another user's feed, it is classified as `IG_PROFILE_MISMATCH` and retried through pool/fallback tiers.
* **Username Sanitization (`sanitizeBridgeUsername`)**:
  - Automatically strips leading `@` characters (`@wwe` -> `wwe`).
  - Resolves profile URLs to clean handles (`https://www.instagram.com/wwe/` -> `wwe`).
  - Rejects post URLs (`/p/...`), reel URLs (`/reel/...`, `/reels/...`), TV URLs (`/tv/...`), story media links, and reserved Instagram routes.
  - Rejects strings containing internal `@` characters (e.g. emails) or pure numeric IDs.
  - Rejects invalid targets prior to dispatching requests to Android automation devices (`INVALID_BRIDGE_TARGET`).
* Normalizes responses via `mapFeedPilotBridgeResponse.js` into standard `web_profile_info`.

### 3.2 Session & Proxy Pool Engine (`src/store/poolStore.js`)
* **Round-Robin Rotation**: Cycles active sessions and proxies.
* **Format Flexibility**: Accepts raw sessionid, cookie strings, Chrome cookie export JSON arrays, or account objects.
* **Automatic Eviction & Verification**: Tests proxies with live IP-echo and Instagram reachability before retrying failed requests.
* **Dual Persistence Backends (`src/store/poolBackend.js`)**: Local disk (`data/pool.json`) or Backblaze B2 bucket.
* **Encryption**: AES-256-GCM encryption with `ENCRYPTION_KEY`.

### 3.3 Private Mobile API & Polaris Hover Card Enrichment (`src/services/instagram.service.js`)
* Uses Instagram's internal Android/iOS mobile endpoints (`/api/v1/feed/user/:userId/`).
* Ensures complete profile data via Polaris hover card GraphQL queries (`PolarisUserHoverCardContentV2Query`).
* Guarantees profile attribution by prioritizing the requested username over collaborator tags.

### 3.4 5-Strategy Numeric User ID Resolution (`src/graphql/service.js`)
* Resolves handles to numeric IDs via up to 5 progressive strategies:
  1. Public `web_profile_info` native HTTPS fetch.
  2. AnonyIG `getUser` client lookup.
  3. Pool client authenticated `web_profile_info` query.
  4. Sessionless story viewer profile lookup (`fetchMedia` in `instagramStory.service.js`) via storynavigation / theasmn.
  5. FastDL `userInfo` client query.
* Fast-path bypass: Accepts `numericUserId` or `userIdNumeric` in query/body to eliminate network resolution calls immediately.

### 3.5 Multi-Tier Fallback Engine (`src/services/feedFallback.service.js`)
* Automatically activates when private sessions return 401, challenges, spam blocks, or when pool sessions are empty.
* Fallback sequence: `FEED_FALLBACK_PROVIDERS` (default: `graphql`, `igram`, rotating `anonyig`/`fastdl`, and optional `bridge`/`feedpilot`).
* **Loop Prevention**: Supports `excludeProviders` and `failedSource` to prevent a failing upstream source from calling itself.
* **Failure Telemetry**: When all providers fail, returns HTTP 502 annotated with a complete `failures` array capturing each provider's error and status.

### 3.6 Worker Hubs (IGram, AnonyIG & FastDL)
* Sessionless Instagram data access over signed HTTP/2 transport layers and worker endpoints.
* Supports per-request proxies (`?proxy=host:port:user:pass`) and provider selection.
* Self-healing chunk mirror scripts (`npm run igram:chunk`, `npm run anonyig:chunk`, `npm run fastdl:chunk`) supporting local/B2 mirror sync.
* Cloudflare Turnstile note: Datacenter IPs are challenged; residential or mobile proxies are required to bypass Turnstile.

### 3.7 Telegram Telemetry & Structured Error Handling
* **Telegram Logger (`src/middleware/telegramRequestLogger.js`, `src/utils/feedResolution.js`)**: Dispatches audit logs of API requests, responses, status codes, execution latencies, and detailed feed resolution metadata (source, path, auth, proxy, fallback provider) directly to Telegram with automatic secret redaction.
* **Global Error Handler (`src/middleware/errorHandler.js`)**: Formats JSON errors `{ success: false, error: message, failures: [...], code: "..." }` preserving diagnostic details from multi-tier fallback chains.

---

## 4. Complete API Endpoint Overview

| Route | Method | Access Level | Description |
| :--- | :--- | :--- | :--- |
| `/health` | GET | Public | Service liveness check |
| `/admin` | GET | Public | Admin dashboard UI |
| `/admin/status` | GET | Public | Pool status & active metrics |
| `/admin/login` | POST | Public | Passcode auth; returns session token |
| `/admin/sessions` | GET / POST / DELETE | Admin Token | Manage session pool |
| `/admin/proxies` | GET / POST / DELETE | Admin Token | Manage proxy pool |
| `/admin/proxies/:id/check` | POST | Admin Token | Tests proxy latency and exit IP |
| `/api/user-feed[/:userId]` | GET / POST | Public / Pool | Fetches feed timeline, stories & highlights (accepts `numericUserId`, `proxy`, `providers`) |
| `/api/exception-users` | GET | Public | Lists exception users (supports `search`, `page`, `pageSize`) or registers if `?username=` supplied |
| `/api/exception-users` | POST | Public | Registers a username in the persistent ExceptionUser list |
| `/api/exception-users/:username` | PUT | Public | Updates/renames an existing exception username |
| `/api/exception-users/:username` | DELETE | Public | Removes a username from the persistent ExceptionUser list |
| `/api/instagram/search[/:username]` | GET / POST | Public | Fetches public stories & highlights |
| `/api/instagram/stories[/:username]` | GET / POST | Public | Stories only |
| `/api/instagram/story[/:username]` | GET / POST | Public | Story alias |
| `/api/instagram/highlights/:highlightId` | GET | Public | Individual highlight items |
| `/api/instagram/media?url=...` | GET | Public | Proxies media asset preview (with allowlist validation) |
| `/api/instagram/download/zip` | POST | Public | Direct zip stream of stories/highlights |
| `/api/instagram/download/zip/start` | POST | Public | Starts async zip job for SSE streaming |
| `/api/instagram/download/zip/:jobId/events` | GET | Public | Real-time SSE progress stream for zip packaging |
| `/api/instagram/download/zip/:jobId/file` | GET | Public | Downloads generated zip archive |
| `/api/igram[/:username]` | GET / POST | Public | Resolves single media, profile feed, or stories via IGram |
| `/api/igram/highlights/:highlightId` | GET | Public | Resolves highlight stories via IGram |
| `/api/anonyig/user[/:username]` | GET / POST | Public | Profile via AnonyIG worker hub |
| `/api/anonyig/feed[/:username]` | GET / POST | Public | Feed via AnonyIG worker hub (accepts `proxy`, `providers`) |
| `/api/fastdl[/:username]` | GET / POST | Public | Resolves single media links or feed via FastDL |
| `/api/graphql[/:username]` | GET / POST | Pool Required | Direct GraphQL query for user timeline |

---

## 5. Execution & Testing

- `npm.cmd test`: Runs built-in test suite (44/44 tests passing).
- `npm.cmd run test:hover-card -- <handle>`: Runs Polaris hover card profile resolution CLI test.
- `npm.cmd run dev`: Development server with nodemon reload.
- `npm start`: Production server bootstrap.
- `npm run igram:chunk`: Refreshes IGram signing chunk.
- `npm run anonyig:chunk`: Refreshes AnonyIG signing chunk and mirrors to B2.
- `npm run fastdl:chunk`: Refreshes FastDL signing chunk and mirrors to B2.

---

## 6. ExceptionUser Routing & Management

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
- **Priority Routing**: Requests to `POST /api/user-feed` or `GET /api/user-feed/:userId` matching any registered exception user automatically execute with `bridge_then_pool` regardless of `FEED_SOURCE_MODE` or bridge toggles. The bridge is attempted first; retryable failures automatically fail over to pool GraphQL / private API / fallback tiers.
- **Normalization**: Usernames are trimmed, leading `@` is stripped, and matching is case-insensitive. Numeric IDs return HTTP 400 (for numeric `userId` feed requests, provide `username` or `handle`).
- **Concurrency & Cache**: Mutations (`add`, `update`, `remove`) are serialized per-process via chained promises (`pendingAdd`). Reads (`list`, `has`) wait for pending mutations. All responses send `Cache-Control: no-store`.
- **Storage**: Persisted under `exceptionUsers` in the pool storage (`data/pool.json` or B2 object) and survives restarts without modifying existing sessions or proxies.
