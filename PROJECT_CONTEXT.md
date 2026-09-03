# GetIGFeed Project Context

Last built: 2026-09-03

## What This Repo Is

GetIGFeed is a Node.js/Express API service for fetching Instagram profile media in several ways:

- Authenticated Instagram private mobile API feed fetches through `/api/user-feed`.
- Sessionless stories/highlights through third-party story sources under `/api/instagram`.
- Sessionless AnonyIG worker-hub access under `/api/anonyig`.
- Sessionless FastDL worker-hub/media resolution under `/api/fastdl`.
- Direct Instagram GraphQL timeline fetches under `/api/graphql`.
- A browser admin dashboard at `/admin` for session/proxy pool management, feed preview, story/highlight preview, proxy checks, and downloads.

The core response shape is Instagram-like `web_profile_info`, with optional top-level `stories`, `highlights`, and `highlight_details` nodes merged into the same payload.

## Runtime

- Language/runtime: CommonJS Node.js, `node >= 18`.
- Web framework: Express 4.
- Entry point: `src/index.js`.
- App wiring: `src/app.js`.
- Main commands:
  - `npm start` -> `node src/index.js`
  - `npm run dev` -> `nodemon src/index.js`
  - `npm test` -> `node --test`
  - `npm run anonyig:chunk`
  - `npm run fastdl:chunk`

## Current Health

`npm.cmd test` was attempted on Windows.

Result:

- FastDL tests passed.
- GraphQL test failed because dependencies are not installed in the workspace: `Cannot find module 'axios'`.
- The plain `npm test` PowerShell command is blocked by local script execution policy because `npm.ps1` cannot be loaded. Use `npm.cmd test` on this machine.

Install dependencies with `npm install` before expecting the full test suite or server startup to work.

## Request Flow: Main Feed

Primary route definitions:

- `src/routes/userFeed.routes.js`
- `src/controllers/userFeed.controller.js`
- `src/services/instagram.service.js`
- `src/services/webParameter.js`
- `src/utils/mapFeedToWebProfile.js`
- `src/services/feedStoryMerge.js`

Flow:

1. `POST /api/user-feed`, `GET /api/user-feed`, `GET /api/user-feed/:userId`, or compatibility route `/api/v1/feed/user/:userId/username`.
2. Controller merges params, query, and body. Body wins over query, query wins over path params.
3. Auth/proxy source priority:
   - `dominatorAccount`
   - inline `authToken`/`sessionid`/`token` plus optional `proxy`
   - encrypted round-robin session/proxy pool
4. Optional in-memory cache is used for first-page responses when enabled/requested.
5. `getUserFeed` builds cookies, CSRF, Bearer `IGT:2` authorization, proxy agent, and headers.
6. Instagram private API endpoint is called:
   - `/api/v1/feed/user/<userId>/?count=PAGE_COUNT`
   - or `/api/v1/feed/user/<username>/username/?count=PAGE_COUNT`
7. Feed items are mapped into `web_profile_info`.
8. If enabled, stories/highlights are fetched by handle and attached as top-level nodes.
9. Feed responses are logged asynchronously through `src/store/feedLog.js`.

## API Route Surface

Public/system:

- `GET /health`
- `GET /admin`
- `GET /instagram-view.html`

Feed:

- `POST /api/user-feed`
- `GET /api/user-feed`
- `GET /api/user-feed/:userId`
- `GET /api/v1/feed/user/:userId/username`

Pool CRUD:

- `POST /api/sessions`
- `GET /api/sessions`
- `DELETE /api/sessions/:id`
- `DELETE /api/sessions`
- `POST /api/proxies`
- `GET /api/proxies`
- `DELETE /api/proxies/:id`
- `DELETE /api/proxies`

Auth token:

- `POST /api/auth-token`
- `GET /api/auth-token`

Stories/downloads:

- `GET|POST /api/instagram/search`
- `GET /api/instagram/search/:username`
- `GET|POST /api/instagram/stories`
- `GET /api/instagram/stories/:username`
- `GET|POST /api/instagram/story`
- `GET /api/instagram/story/:username`
- `GET /api/instagram/highlights/:highlightId`
- `GET /api/instagram/media?url=...`
- `POST /api/instagram/download/zip`
- `POST /api/instagram/download/zip/start`
- `GET /api/instagram/download/zip/:jobId/events`
- `GET /api/instagram/download/zip/:jobId/file`

AnonyIG:

- `GET|POST /api/anonyig/user`
- `GET /api/anonyig/user/:username`
- `GET /api/anonyig/posts/:username`
- `GET /api/anonyig/reels/:username`
- `GET /api/anonyig/stories/:username`
- `GET /api/anonyig/highlights/:username`
- `GET|POST /api/anonyig/feed`
- `GET /api/anonyig/feed/:username`
- `GET|POST /api/anonyig/profile`
- `GET /api/anonyig/profile/:username`
- `GET /api/anonyig/suggestions?query=...`
- `GET /api/anonyig/status`

FastDL:

- `GET|POST /api/fastdl`
- `GET /api/fastdl/:username`
- `GET /api/fastdl/highlights/:highlightId`
- `GET /api/fastdl/status`

GraphQL:

- `GET|POST /api/graphql`
- `GET /api/graphql/:username`

Admin route group:

- Public/login/status/dashboard routes are under `/admin`.
- Session/proxy CRUD routes under `/admin` are passcode-token gated.
- Admin feed/story fetch routes are intentionally not token-gated because they do not expose stored secrets.

## Storage And Secrets

Session/proxy pool:

- Store module: `src/store/poolStore.js`.
- Backend module: `src/store/poolBackend.js`.
- Local default: `DATA_DIR/pool.json`, with `DATA_DIR` defaulting to `./data`.
- Remote option: Backblaze B2/S3-compatible storage when all required B2 variables are configured.
- Secrets are encrypted per entry with AES-256-GCM through `src/utils/crypto.js`.
- List endpoints return only masked/non-secret fields.
- Decryption happens at request time when building cookies/proxy config.

Important secret/config variables:

- `ENCRYPTION_KEY`
- `ADMIN_PASSCODE`
- `B2_BUCKET`
- `B2_ENDPOINT`
- `B2_REGION`
- `B2_KEY_ID`
- `B2_APPLICATION_KEY`
- `B2_POOL_KEY`

## Cache And Logging

Cache:

- Utility: `src/utils/cache.js`.
- Feed cache defaults to disabled unless `FEED_CACHE_DEFAULT=true` or callers request `useCache/cache=true`.
- Bypassed by `fresh=true` or `bypassCache=true`.
- Not used for paginated `maxId` requests.

Logging:

- Feed logs are written by `src/store/feedLog.js`.
- Controlled by `FEED_LOG_ENABLED`.
- Intended to avoid writing raw secrets.

## Media Downloads

Download service: `src/services/download.service.js`.

Capabilities:

- Single media proxy/inline preview.
- One-shot zip streaming.
- Background zip jobs with Server-Sent Events progress and later file download.

Safety:

- Media URLs are validated by `assertAllowedUrl`.
- Only configured/allow-listed hosts are downloadable.
- Zip item count is capped by `STORY_MAX_ZIP_ITEMS`.

## Third-Party Worker Hub Modules

AnonyIG module:

- Directory: `src/anonyig`.
- Uses signed HTTP/2 requests to `api-wh.anonyig.com`.
- Signing chunk is not committed and can be loaded from disk, B2, or fetched from anonyig.com.
- Cloud hosts may need `ANONYIG_PROXY` or `ANONYIG_USE_POOL_PROXY=true` because worker hubs can challenge datacenter IP ranges.

FastDL module:

- Directory: `src/fastdl`.
- Similar signed worker-hub design for `fastdl.app`.
- Has tests in `src/fastdl/fastdl.test.js`.

## Environment Notes

Local development should usually start with:

```bash
npm install
copy .env.example .env
npm.cmd run dev
```

On this Windows host, prefer `npm.cmd` instead of bare `npm` in PowerShell if script execution policy blocks `npm.ps1`.

## Things To Be Careful With

- Do not commit `.env`, `data/`, pool JSON files, feed logs, sessions, proxies, or signing chunks.
- Keep `ENCRYPTION_KEY` stable. Changing it makes stored pool entries undecryptable.
- Story/highlight providers are best-effort and should not fail the main feed.
- The AnonyIG/FastDL signing chunks are operational dependencies for those route groups.
- Some docs currently contain mojibake characters, likely from an encoding mismatch; code comments show the same issue in a few places.
- The checked-in `context.md` references an older path (`d:/CoreProject/GetIGFeed`) even though this workspace is `D:\GetIGFeed`.
