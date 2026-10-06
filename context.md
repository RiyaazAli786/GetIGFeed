# GetIGFeed — Complete Workspace & Architecture Context

> Living reference for the entire GetIGFeed repository. Last updated on 2026-10-04.
> Companion docs: [Master.md](file:///c:/CoreProjects/GetIGFeed/Master.md) (API Reference), [API.md](file:///c:/CoreProjects/GetIGFeed/API.md) (Detailed API Specification), [Run.md](file:///c:/CoreProjects/GetIGFeed/Run.md) (Operational Guide), [DEPLOY.md](file:///c:/CoreProjects/GetIGFeed/DEPLOY.md) (Render Deployment), [DEPLOY_VPS.md](file:///c:/CoreProjects/GetIGFeed/DEPLOY_VPS.md) (VPS & Docker Deployment), [PROJECT_CONTEXT.md](file:///c:/CoreProjects/GetIGFeed/PROJECT_CONTEXT.md) (Project Context).

---

## Executive Summary

**GetIGFeed** is a high-performance, resilient Node.js / Express API microservice and multi-tiered scraping engine designed to fetch Instagram user feeds, stories, highlights, posts, reels, and media assets. It acts as an intelligent orchestration layer across:

1. **FeedPilot Android Device Bridge**: Direct physical Android device execution for anti-bot bypass.
2. **Instagram Private Mobile API**: Direct `/api/v1/` mobile endpoint fetching with session cookie jars and rotating proxies.
3. **Polaris GraphQL Hover Card Enrichment**: Resolves complete profile counts (followers/following) while preserving the requested user handle against collaborator post overrides.
4. **Automated Session & Proxy Pool**: Round-robin rotation, proxy validation, automated failover, and dual persistence backends (local filesystem or Backblaze B2). Supports Chrome cookie export JSON arrays.
5. **Sessionless Fallback Engine**: Automatic failover to public providers (IGram, AnonyIG, FastDL) on 401, challenge, or empty session pool.
6. **Third-Party Story Platforms & Signed HTTP/2 Worker Hubs**: IGram, AnonyIG, and FastDL signed worker hub clients.
7. **Telegram Telemetry & Audit**: Real-time request, response, and feed resolution logging to Telegram with sensitive credential masking.

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
│ FeedPilot Bridge     │ │ Private Mobile API   │ │ Sessionless Fallback │ │ Session & Proxy Pool Store   │
│ (src/services/       │ │ (src/services/       │ │ Engine (IGram,       │ │ (src/store/poolStore.js)     │
│  feedPilotBridge)    │ │  instagram.service)  │ │  AnonyIG & FastDL)   │ │ Encrypted AES-256-GCM        │
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
│   ├── graphql/              # Direct Instagram GraphQL timeline module
│   ├── store/                # In-memory storage & persistence engines
│   │   ├── poolStore.js               # Round-robin session & proxy pool manager
│   │   ├── poolBackend.js             # File system vs Backblaze B2 backend switcher
│   │   ├── tokenStore.js              # Session token cache
│   │   └── feedLog.js                 # Audit logger for incoming feed requests
│   ├── parsers/              # Response payload normalization
│   ├── middleware/           # Express middlewares
│   │   ├── errorHandler.js            # Global error handler & 404
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
* Automatically falls back to local pool/session scraping upon retryable errors (503, 504, device offline, timeouts).
* Normalizes response via `mapFeedPilotBridgeResponse.js` into standard `web_profile_info`.

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

### 3.4 Multi-Tier Fallback Engine (`src/services/feedFallback.service.js`)
* Automatically activates when private sessions return 401, challenges, spam blocks, or when pool sessions are empty.
* Fallback sequence: `FEED_FALLBACK_PROVIDERS` (default: `graphql`, `igram`, then rotating `anonyig`/`fastdl`).
* Respects per-request/environment switches for IGram (`USER_FEED_IGRAM_FALLBACK`) and worker hubs (`USER_FEED_HUB_FALLBACK`).
* Re-formats external provider data into standard `web_profile_info`.

### 3.5 Worker Hubs (IGram, AnonyIG & FastDL)
* Sessionless Instagram data access over signed HTTP/2 transport layers and worker endpoints.
* Self-healing chunk mirror scripts (`npm run igram:chunk`, `npm run anonyig:chunk`, `npm run fastdl:chunk`) supporting local/B2 mirror sync.

### 3.6 Telegram Telemetry & Feed Resolution (`src/middleware/telegramRequestLogger.js`, `src/utils/feedResolution.js`)
* Dispatches audit logs of API requests, responses, status codes, execution latencies, and detailed feed resolution metadata (source, path, auth, proxy, fallback provider) directly to Telegram.
* Automatic redacting of all authentication tokens, session cookies, passwords, and private headers.

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
| `/api/user-feed[/:userId]` | GET / POST | Public / Pool | Fetches feed timeline, stories & highlights |
| `/api/instagram/search[/:username]` | GET / POST | Public | Fetches public stories & highlights |
| `/api/instagram/download/zip` | POST | Public | Direct zip stream of stories/highlights |
| `/api/instagram/download/zip/start` | POST | Public | Starts async zip job for SSE streaming |
| `/api/instagram/download/zip/:jobId/events` | GET | Public | Real-time SSE progress stream for zip packaging |
| `/api/igram[/:username]` | GET / POST | Public | Resolves single media, profile feed, or stories via IGram |
| `/api/igram/highlights/:highlightId` | GET | Public | Resolves highlight stories via IGram |
| `/api/anonyig/user[/:username]` | GET / POST | Public | Profile via AnonyIG worker hub |
| `/api/anonyig/feed[/:username]` | GET / POST | Public | Feed via AnonyIG worker hub |
| `/api/fastdl[/:username]` | GET / POST | Public | Resolves single media links or feed via FastDL |
| `/api/graphql[/:username]` | GET / POST | Pool Required | Direct GraphQL query for user timeline |

---

## 5. Execution & Testing

- `npm.cmd test`: Runs built-in test suite (40/40 tests passing).
- `npm.cmd run test:hover-card -- <handle>`: Runs Polaris hover card profile resolution CLI test.
- `npm.cmd run dev`: Development server with nodemon reload.
- `npm start`: Production server bootstrap.
- `npm run igram:chunk`: Refreshes IGram signing chunk.
- `npm run anonyig:chunk`: Refreshes AnonyIG signing chunk and mirrors to B2.
- `npm run fastdl:chunk`: Refreshes FastDL signing chunk and mirrors to B2.

## ExceptionUser routing

`GET /api/exception-users?username=example.user` registers a username in the persistent ExceptionUser list. `POST /api/exception-users` also remains supported with a JSON body:

```json
{ "username": "example.user" }
```

Returns HTTP 201 when added, or HTTP 200 if already registered:

```json
{ "success": true, "username": "example.user", "added": true, "userExist": false, "status": "added", "feedSourceMode": "bridge_then_pool" }
```

Handles are trimmed, an optional leading `@` is removed, and matching is case-insensitive. Invalid handles, missing usernames, and numeric IDs return HTTP 400. Repeated registration is idempotent and returns HTTP 200 with `added: false`, `userExist: true`, and `status: "exists"`, without inserting another entry. New registrations return `userExist: false` and `status: "added"`. Registration responses use `Cache-Control: no-store`. Concurrent registrations are serialized within each server process.

Call `POST /api/user-feed` with `{ "userId": "example.user" }` (or the GET equivalent). Registered users use `bridge_then_pool` regardless of `FEED_SOURCE_MODE` or legacy bridge toggles. The bridge is attempted first; retryable failures (including missing bridge configuration) continue through the existing local GraphQL/private API pool and fallback pipeline. Non-retryable bridge errors retain their existing error behavior. Other usernames follow environment configuration. Requests with `maxId`/`max_id` retain the existing pagination behavior and skip the bridge.

For numeric `userId` requests, supply `username` or `handle` to match the list; no numeric-ID-to-username lookup is performed. Bridge URL and key still come from `FEEDPILOT_BRIDGE_URL` and `FEEDPILOT_BRIDGE_KEY`. This endpoint follows the existing public `/api` route convention and requires no admin token.

The list is stored as `exceptionUsers` in the existing pool blob (`DATA_DIR/pool.json`, or the configured B2 pool object), survives restarts, and preserves existing sessions and proxies. No removal endpoint is provided.
