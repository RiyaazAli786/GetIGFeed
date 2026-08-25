# GetIGFeed — Complete Workspace & Architecture Context

> Living reference for the entire GetIGFeed repository. Last updated on 2026-08-25.
> Companion docs: [Master.md](file:///c:/CoreProjects/GetIGFeed/Master.md) (API Reference), [API.md](file:///c:/CoreProjects/GetIGFeed/API.md) (Detailed API Specification), [Run.md](file:///c:/CoreProjects/GetIGFeed/Run.md) (Operational Guide), [DEPLOY.md](file:///c:/CoreProjects/GetIGFeed/DEPLOY.md) (Render Deployment), [DEPLOY_VPS.md](file:///c:/CoreProjects/GetIGFeed/DEPLOY_VPS.md) (VPS & Docker Deployment).

---

## Executive Summary

**GetIGFeed** is a high-performance, resilient Node.js / Express API microservice and web scraping engine designed to fetch Instagram user feeds, stories, highlights, posts, reels, and media assets. It acts as an abstraction layer over Instagram's private mobile API, official GraphQL endpoints, third-party viewer platforms (StoryNavigation, AnonStories), and signed HTTP/2 worker hubs (Anonyig, FastDL).

The service features an automated **session and proxy pool management engine** supporting live rotation, proxy validation, automated failover, and dual persistence backends (local filesystem or Backblaze B2 cloud storage). It also provides an in-browser administrative control panel for pool monitoring and bulk session configuration.

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
                                 │             Morgan Logging + Error Handlers            │
                                 └───────────────┬─────────────────────────┬──────────────┘
                                                 │                         │
                 ┌───────────────────────────────┴──────────┐   ┌──────────┴──────────────────────────────┐
                 │ Public API Routes                        │   │ Admin Gated Routes                      │
                 │ (/api/user-feed, /api/instagram, etc.)   │   │ (/admin/* via passcode session)          │
                 └───────────────┬──────────────────────────┘   └──────────┬──────────────────────────────┘
                                 │                                         │
 ┌───────────────────────────────┼───────────────────────────────┬─────────┴──────────────────────────────┐
 │                               │                               │                                        │
 ▼                               ▼                               ▼                                        ▼
┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────────────┐
│ Private API Scraper  │ │ Anonyig HTTP/2 Hub   │ │ FastDL HTTP/2 Hub    │ │ Session & Proxy Pool Store   │
│ (src/services)       │ │ (src/anonyig)        │ │ (src/fastdl)         │ │ (src/store/poolStore.js)     │
└──────────┬───────────┘ └──────────┬───────────┘ └──────────┬───────────┘ └──────────────┬───────────────┘
           │                        │                        │                            │
           │ Proxy & Cookie Agent   │ HTTP/2 Signed Headers  │ HTTP/2 Signed Headers      │ Persistence Layer
           ▼                        ▼                        ▼                            ▼
┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────────────┐
│ Instagram Mobile /   │ │ anonyig.com Hub      │ │ fastdl.app Hub       │ │ Local JSON (data/pool.json)  │
│ GraphQL Endpoints    │ │ Upstream Servers     │ │ Upstream Servers     │ │ or Backblaze B2 Object Bucket│
└──────────────────────┘ └──────────────────────┘ └──────────────────────┘ └──────────────────────────────┘
```

---

## 2. Workspace & Directory Structure

```
GetIGFeed/
├── .github/                  # Automated workflows and deployment actions
├── deploy/                   # Production Nginx configs & systemd unit files
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
│   │   ├── instagram.service.js       # Private Mobile API feed fetcher
│   │   ├── instagramStory.service.js  # Web story & highlight fetcher
│   │   ├── storyFetcher.js            # Third-party story viewer scrapers
│   │   ├── download.service.js        # Multi-file zip archiver & progress stream
│   │   ├── proxyCheck.js              # Proxy connectivity & latency tester
│   │   ├── adminAuth.js               # Passcode hashing & sliding window admin token
│   │   ├── browserFallback.js         # Headless browser fallback client
│   │   ├── feedStoryMerge.js          # Merges feed timeline with stories & highlights
│   │   └── webParameter.js            # Query signature generator for web API calls
│   ├── anonyig/              # Anonyig worker hub subsystem (HTTP/2 transport)
│   │   ├── client.js                  # Signed HTTP/2 connection manager
│   │   ├── signer.js                  # Request signature generator
│   │   ├── chunk.js                   # Signing chunk mirror & updater script
│   │   ├── convertedFeed.js           # Format adapter to standard web_profile_info
│   │   ├── proxy.js                   # Proxy agent binding for worker hub requests
│   │   ├── routes.js                  # Router mounted under /api/anonyig
│   │   └── controller.js / service.js # Controllers and services
│   ├── fastdl/               # FastDL.app worker hub subsystem
│   │   ├── client.js                  # FastDL HTTP/2 transport
│   │   ├── signer.js                  # FastDL signature calculation
│   │   ├── chunk.js                   # FastDL chunk file mirror
│   │   ├── convertedFeed.js           # FastDL to web_profile_info transformer
│   │   └── routes.js / controller.js  # Router mounted under /api/fastdl
│   ├── graphql/              # Direct Instagram GraphQL timeline module
│   │   ├── service.js                 # GraphQL query runner using doc_id
│   │   └── routes.js / controller.js  # Router mounted under /api/graphql
│   ├── store/                # In-memory storage & persistence engines
│   │   ├── poolStore.js               # Round-robin session & proxy pool manager
│   │   ├── poolBackend.js             # File system vs Backblaze B2 backend switcher
│   │   ├── tokenStore.js              # Session token cache
│   │   └── feedLog.js                 # Audit logger for incoming feed requests
│   ├── parsers/              # Response payload normalization
│   │   ├── instagramStoriesResponseHandler.js
│   │   └── mediaDetailsResponseHandler.js
│   ├── config/               # System defaults and constants
│   │   ├── constants.js
│   │   └── story.js
│   ├── middleware/           # Express middlewares (error handling, validation)
│   ├── utils/                # General utilities (crypto, httpFetch, json, string formatters)
│   └── public/               # Admin web dashboard HTML & assets
├── Dockerfile                # Multi-stage production container definition
├── docker-compose.yml        # Docker composition setup
├── render.yaml               # Render cloud platform deployment specification
├── Master.md                 # Complete Master API documentation
├── API.md                    # In-depth API endpoint catalog
├── Run.md                    # Local setup and developer execution instructions
├── DEPLOY.md                 # Render deployment guide
├── DEPLOY_VPS.md             # VPS Docker & Nginx hosting instructions
├── README.md                 # Repository introduction & quick start
├── package.json              # Dependencies and script commands
└── .env.example              # Template for environment configuration
```

---

## 3. Core Engine & Key Subsystems

### 3.1 Session & Proxy Pool Engine (`src/store/poolStore.js`)
* **Round-Robin Rotation**: Distributes incoming requests across active Instagram sessions and proxy nodes.
* **Automatic Eviction**: Automatically flags or removes expired sessions (`sessionid` invalidation) or dead proxies.
* **Dual Persistence Backends (`src/store/poolBackend.js`)**:
  * `file`: Stores state on the local disk (`data/pool.json`).
  * `b2`: Synchronizes pool state with a Backblaze B2 object storage bucket for stateless container deployments (e.g. Render, AWS Fargate).
* **Encryption**: Sensitive credentials (passwords, proxy auth, session tokens) are encrypted at rest using AES-256-GCM.

### 3.2 Private Mobile API Engine (`src/services/instagram.service.js`)
* Uses Instagram's internal Android/iOS mobile endpoints (`/api/v1/feed/user/:userId/`).
* Returns timeline posts, video metadata, captions, likes, and comment counts.
* Normalizes response payloads into Instagram's standard `web_profile_info` JSON format for frontend compatibility (`src/utils/mapFeedToWebProfile.js`).

### 3.3 Anonyig Worker Hub (`src/anonyig/`)
* Provides sessionless Instagram data access over a signed HTTP/2 transport layer (`src/anonyig/client.js`).
* Does not require Instagram session credentials or local proxies.
* Features a self-healing chunk fetcher (`src/anonyig/chunk.js`) that mirrors signed JS chunks to Backblaze B2 to bypass regional geoblocking (HTTP 451).

### 3.4 FastDL Integration (`src/fastdl/`)
* Resolves direct CDN download links for Instagram posts, reels, and stories via `fastdl.app`.
* Supports single-hit media extraction without requiring an active pool session.

### 3.5 GraphQL Timeline Module (`src/graphql/`)
* Executes targeted GraphQL queries against Instagram's official frontend GraphQL endpoints using persisted `doc_id` parameters.
* Utilizes authenticated session headers from the pool for maximum rate limit efficiency.

### 3.6 Multi-File Zip Download & Progress Engine (`src/services/download.service.js`)
* Packages user stories, highlights, and profile media into organized zip archives.
* Supports **Server-Sent Events (SSE)** streaming (`/api/instagram/download/zip/:jobId/events`) for real-time progress monitoring in client UI applications.

---

## 4. Complete API Endpoint Overview

| Prefix / Route | Method | Access Level | Description |
| :--- | :--- | :--- | :--- |
| `/health` | GET | Public | System liveness check |
| `/admin` | GET | Public | Serves administrative web dashboard UI |
| `/admin/status` | GET | Public | Returns pool metrics and active system state |
| `/admin/login` | POST | Public | Authenticates passcode; returns sliding session token |
| `/admin/sessions` | GET / POST / DELETE | Admin Token | Manage IG session pool |
| `/admin/proxies` | GET / POST / DELETE | Admin Token | Manage proxy pool |
| `/admin/proxies/:id/check` | POST | Admin Token | Tests proxy latency and public IP |
| `/api/user-feed[/:userId]` | GET / POST | Public / Pool | Fetches private API timeline feed, stories & highlights |
| `/api/instagram/search[/:username]` | GET / POST | Public | Fetches public stories & highlights without session |
| `/api/instagram/download/zip` | POST | Public | Direct stream zip archive of selected stories/highlights |
| `/api/instagram/download/zip/start` | POST | Public | Initiates async zip archive job for SSE streaming |
| `/api/instagram/download/zip/:jobId/events` | GET | Public | Real-time SSE progress stream for zip packaging |
| `/api/anonyig/user[/:username]` | GET / POST | Public | Fetches user profile via Anonyig worker hub |
| `/api/anonyig/feed[/:username]` | GET / POST | Public | Consolidated timeline feed via Anonyig worker hub |
| `/api/fastdl[/:username]` | GET / POST | Public | Resolves single media links or profile feeds via FastDL |
| `/api/graphql[/:username]` | GET / POST | Pool Required | Direct GraphQL query for user timeline posts |

---

## 5. Configuration & Environment Variables

| Variable | Type | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `PORT` | Number | `3000` | HTTP web server port |
| `NODE_ENV` | String | `development` | Environment mode (`development` / `production`) |
| `ADMIN_PASSCODE` | String | *Required* | Admin dashboard passcode |
| `STORAGE_BACKEND` | String | `file` | Pool persistence type (`file` or `b2`) |
| `B2_APPLICATION_KEY_ID` | String | Optional | Backblaze B2 account Key ID (required for B2 storage) |
| `B2_APPLICATION_KEY` | String | Optional | Backblaze B2 Application Key |
| `B2_BUCKET_NAME` | String | Optional | Backblaze B2 Target Bucket Name |
| `ANONYIG_PROXY` | String | Optional | Explicit proxy for Anonyig HTTP/2 client |
| `FASTDL_PROXY` | String | Optional | Explicit proxy for FastDL HTTP/2 client |
| `STORY_MAX_ZIP_ITEMS` | Number | `300` | Maximum media files allowed per single zip archive |

---

## 6. Execution & NPM Commands

* `npm start`: Bootstraps production server (`node src/index.js`).
* `npm run dev`: Bootstraps development server with live reload (`nodemon src/index.js`).
* `npm test`: Runs built-in test suite (`node --test`).
* `npm run anonyig:chunk`: Refreshes and mirrors Anonyig signing chunk to B2 storage.
* `npm run fastdl:chunk`: Refreshes and mirrors FastDL signing chunk to B2 storage.

---

## 7. Key Maintenance & Operational Guides

* **[Master API Reference](file:///c:/CoreProjects/GetIGFeed/Master.md)**: Exhaustive request and response shape specifications.
* **[Developer Setup & Execution Guide](file:///c:/CoreProjects/GetIGFeed/Run.md)**: Operational guide for local execution, test cases, and troubleshooting.
* **[Render Hosting Deployment](file:///c:/CoreProjects/GetIGFeed/DEPLOY.md)**: Instructions for deploying to Render platform with B2 storage backend.
* **[VPS & Docker Deployment](file:///c:/CoreProjects/GetIGFeed/DEPLOY_VPS.md)**: Container deployment guide for Hostinger / VPS environments with Nginx reverse proxy.
