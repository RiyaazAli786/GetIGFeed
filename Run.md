# Run & Usage Guide

How to run the GetUserFeed API locally and use every endpoint.

## 1. Prerequisites

- **Node.js 18+** (uses `crypto.randomUUID`, global `fetch`, and built-in
  `node --test`).
- npm (ships with Node).
- Optional: `npm i puppeteer`, only for the story browser fallback
  (`ENABLE_BROWSER_FALLBACK=true`).

Check your version:

```bash
node -v
```

## 2. Install

```bash
npm install
```

## 3. Configure environment

Create your `.env` from the template:

```bash
cp .env.example .env
```

Then open `.env` and set an **encryption key** (required before storing real
sessions/proxies — it encrypts them at rest with AES-256-GCM):

```bash
# generate a strong key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the output into `.env`:

```
PORT=3000
NODE_ENV=development
ENCRYPTION_KEY=<paste-the-generated-key>
```

> If `ENCRYPTION_KEY` is missing, the server still runs but falls back to an
> insecure dev key and logs a warning. Do not store real secrets without a key.

## 4. Run the server

Development (auto-reload via nodemon):

```bash
npm run dev
```

Production-style (plain node):

```bash
npm start
```

You should see:

```
GetUserFeed API listening on http://localhost:3000
```

Health check:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

Stop the server with `Ctrl+C` (it shuts down gracefully).

---

## 5. Usage

Base URL: `http://localhost:3000`

### 5.1 Add proxies (bulk)

Accepts `ip:port`, `ip:port:user:pass`, `user:pass@ip:port`, or
`http://user:pass@ip:port` — as strings or objects. Duplicates are skipped.

```bash
curl -X POST http://localhost:3000/api/proxies \
  -H "Content-Type: application/json" \
  -d '{"proxies":[
        "1.2.3.4:8080:user:pass",
        "5.6.7.8:3128",
        "user2:pass2@9.9.9.9:9090"
      ]}'
```

**Luminati / Bright Data proxies** — pass an object; the username is built
automatically as `<customer>-zone-<zone>` (plus optional `country`/`session`):

```bash
curl -X POST http://localhost:3000/api/proxies \
  -H "Content-Type: application/json" \
  -d '{"proxies":[
        { "url":"zproxy.lum-superproxy.io", "port":22225,
          "customer":"lum-customer-c_e11f9742",
          "zone":"residntzone", "password":"n0oioikax2i2",
          "label":"lum-residential" }
      ]}'
```

| Field | Meaning |
| ----- | ------- |
| `url` (or `host`) | proxy host, e.g. `zproxy.lum-superproxy.io` |
| `port` | e.g. `22225` |
| `customer` | e.g. `lum-customer-c_e11f9742` (used as-is) |
| `zone` | e.g. `residntzone`, `datacenternew_test`, `mobizone-mobile` |
| `password` | that zone's password |
| `country` *(optional)* | adds `-country-us` etc. |
| `session` *(optional)* | adds `-session-<id>` for a sticky IP |
| `label` *(optional)* | your own name for the entry |

### 5.2 Add sessions (bulk)

Each item may be a raw `sessionid`, a cookie string, or an object. Duplicates
(same `sessionid`) are skipped. `ds_user_id` is auto-derived from the sessionid.

```bash
curl -X POST http://localhost:3000/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"sessions":[
        "64827392%3AAbCdEf...%3A17",
        "sessionid=99887766%3A...; csrftoken=abc; ds_user_id=99887766; mid=xyz",
        {"sessionid":"111%3A...","label":"acct-3"}
      ]}'
```

### 5.3 List what is stored (secrets are masked)

```bash
curl http://localhost:3000/api/sessions
curl http://localhost:3000/api/proxies
```

Session ids come back masked (e.g. `********oken`); proxy credentials are never
returned — only host/port and a `hasAuth` flag.

### 5.4 Delete

```bash
# delete one by id (copy an id from the list output)
curl -X DELETE http://localhost:3000/api/sessions/<id>
curl -X DELETE http://localhost:3000/api/proxies/<id>

# clear all
curl -X DELETE http://localhost:3000/api/sessions
curl -X DELETE http://localhost:3000/api/proxies
```

### 5.5 Fetch a user feed

`userId` accepts an Instagram **username** (e.g. `incindia`, `wwe`) or a numeric
user id — both resolve the same feed. Available as `POST /api/user-feed` or
`GET /api/user-feed?userId=...` (also `GET /api/user-feed/:userId`).

You do **not** need a `dominatorAccount`. Auth is resolved in this order:
`dominatorAccount` → `authToken`/`proxy` in the body → the encrypted pool.

**Option A — just an auth token + proxy in the request (simplest):**

```bash
curl -X POST http://localhost:3000/api/user-feed \
  -H "Content-Type: application/json" \
  -d '{
        "userId": "7425066841",
        "authToken": "64827392%3AAbCdEf...%3A17",
        "proxy": "1.2.3.4:8080:user:pass"
      }'
```

`proxy` also accepts `user:pass@ip:port`, `http://user:pass@ip:port`, a Luminati
object (see 5.1), or any proxy object. `csrfToken` is optional. Leave `proxy`
out to take one from the pool; if there is no proxy anywhere, the request goes
**direct** (through the local machine).

**Option B — nothing but `userId`, using the stored pool:**

Add sessions/proxies once (5.1–5.2), then a session + proxy are pulled from the
pool (round-robin), **decrypted**, and used automatically:

```bash
curl -X POST http://localhost:3000/api/user-feed \
  -H "Content-Type: application/json" \
  -d '{"userId":"7425066841"}'
```

**Option C — full `dominatorAccount` (legacy):** pass the whole account object
(`cookies`, `deviceDetails`, `accountBaseModel.accountProxy`) in the body if you
already have one. Otherwise prefer Option A or B.

**Response** — only the **first page (12 most recent posts)** is fetched (no
pagination), returned in the `web_profile_info` shape:

```json
{
  "data": {
    "user": {
      "id": "44725523631",
      "username": "schloesser_",
      "profile_pic_url": "https://...",
      "profile_pic_url_hd": "https://...",
      "edge_followed_by": { "count": 12345678 },
      "edge_follow": { "count": 42 },
      "edge_owner_to_timeline_media": {
        "count": 12,
        "page_info": { "has_next_page": true, "end_cursor": "<cursor>" },
        "edges": [
          { "node": {
            "__typename": "GraphImage",
            "shortcode": "DViRVs-DJn3",
            "display_url": "https://...",
            "is_video": false,
            "edge_media_to_caption": { "edges": [{ "node": { "text": "..." } }] },
            "edge_liked_by": { "count": 3 },
            "edge_media_to_comment": { "count": 0 },
            "taken_at_timestamp": 1772783983,
            "owner": { "id": "...", "username": "schloesser_" }
          } }
        ]
      }
    }
  },
  "status": "ok",

  "stories":           { "available": true, "count": 2, "source": "storynavigation", "items": [ … ] },
  "highlights":        { "available": true, "count": 6, "source": "storynavigation", "items": [ … ] },
  "highlight_details": { "available": true, "count": 10, "truncated": false, "items": [ … ] }
}
```

HTTP `200` when posts are returned, `502` when the feed is empty (see
Troubleshooting).

### 5.6 Stories & highlights

Every feed call also fetches the account's **active stories** and **highlights**
and merges them into the same JSON as the `stories`, `highlights` and
`highlight_details` nodes shown above. Those come from third-party story viewers
(storynavigation.com, anonstories.com, i.theasmn.com), so they use **no session
and no proxy**, and a failure there never fails the feed — it shows up as
`stories.error` instead.

Stories, the highlight list, and each highlight's media each fall back from
storynavigation.com to anonstories.com **independently**, judged by whether the
response actually parsed into items (storynavigation signals failure in several
different ways, so its raw body cannot be trusted). That is why
`stories.source` and `highlights.source` often name different sources; `null`
means neither source had anything.

When a list is empty, its `error` says why — and only when a source actually
failed:

- `"anonstories: HTTP 429 — Too many requests"` — **transient**. anonstories
  allows only a handful of rapid requests; calls to it are already spaced
  (`STORY_ANON_MIN_INTERVAL_MS`), cached (`STORY_ANON_CACHE_TTL_MS`) and retried
  once (`STORY_RETRY_DELAY_MS`), so this means the window is still closed. Retry
  in a minute.
- `"storynavigation: CSRF token mismatch."` — its session expired; one fresh
  handshake is attempted automatically before this is reported.
- `error: null` with a count of 0 — both sources answered fine and simply hold no
  highlights for that account. The viewers only know what they have crawled, so
  this can happen for accounts that do have highlights on Instagram.

**Every highlight is expanded automatically**, so one feed call also returns the
media inside each bubble under `highlight_details.items`, **keyed by highlight
id**:

```jsonc
"highlight_details": {
  "available": true, "count": 4, "truncated": false, "error": null,
  "items": {
    "18201653992314974": { "id": "18201653992314974", "title": "Artemis III", "count": 20, "items": [ … ] },
    "18029499352961095": { "id": "18029499352961095", "title": "MoonTunes",   "count": 11, "items": [ … ] }
  }
}
```

Per-request switches (also accepted as query params on the GET form):

```bash
# skip the story/highlight lookup entirely
curl -X POST http://localhost:3000/api/user-feed \
  -H "Content-Type: application/json" \
  -d '{"userId":"instagram","includeStories":false}'

# bubbles only, without expanding their media (fastest)
curl -X POST http://localhost:3000/api/user-feed \
  -H "Content-Type: application/json" \
  -d '{"userId":"instagram","includeHighlightDetails":false}'

# expand only the first 5 highlights (bounds the response time)
curl -X POST http://localhost:3000/api/user-feed \
  -H "Content-Type: application/json" \
  -d '{"userId":"instagram","highlightDetailLimit":5}'
```

Defaults come from `FEED_INCLUDE_STORIES`,
`FEED_INCLUDE_HIGHLIGHT_DETAILS`, `FEED_HIGHLIGHT_DETAIL_LIMIT` (0 = all) and
`FEED_HIGHLIGHT_DETAIL_CONCURRENCY` (5) — see `.env.example`. Expanding a
highlight costs one upstream call, so an account with dozens of highlights makes
the call slower; with a positive limit the response reports
`highlight_details.truncated: true` and each unexpanded bubble has
`itemCount: null`.

Stories and highlights on their own, without touching Instagram:

```bash
# profile + stories + highlight bubbles + every bubble's media (all automatic)
curl http://localhost:3000/api/instagram/search?username=instagram

# bubbles only, no per-highlight media
curl "http://localhost:3000/api/instagram/search?username=instagram&includeHighlightDetails=false"

# the media inside one bubble (userId = numeric id, for the fallback source)
curl "http://localhost:3000/api/instagram/highlights/18142207969557132?username=instagram&userId=25025320"
```

Downloading media — the CDN links expire quickly and reject requests without a
browser `Referer`, so fetch them through the proxy:

```bash
# one file (add &inline=1 to preview instead of download)
curl -o story.mp4 "http://localhost:3000/api/instagram/media?url=<encoded-url>&filename=story.mp4"

# many files as a zip (Stories/… and Highlights/<title>/… folders inside)
curl -X POST http://localhost:3000/api/instagram/download/zip \
  -H "Content-Type: application/json" \
  -d '{"username":"instagram","items":[{"url":"https://…","type":"video","kind":"story"}]}' \
  -o instagram.zip
```

For a progress bar, `POST /api/instagram/download/zip/start` returns a `jobId`;
follow `GET …/zip/:jobId/events` (SSE, one message per file) and then download
`GET …/zip/:jobId/file`. The dashboard's **Stories & Highlights** tab does
exactly this.

Optional last resort: with `ENABLE_BROWSER_FALLBACK=true` and `npm i puppeteer`,
a public account that returns no stories from any HTTP source is scraped from
anonyig.com in a headless browser.

### 5.7 anonyig: user details, posts, reels, stories, highlights

A second session-free source, from a different upstream than 5.6 — the anonyig
worker hub. No setup: the signing chunk it needs is downloaded on the first
request. Details in [src/anonyig/README.md](src/anonyig/README.md).

```bash
# user details — the profile header on its own
curl http://localhost:3000/api/anonyig/user/nasa
curl "http://localhost:3000/api/anonyig/user?username=@nasa"
curl -X POST http://localhost:3000/api/anonyig/user \
  -H "Content-Type: application/json" -d '{"username":"nasa"}'

# tabs (?pages= is ~12 posts per page, one upstream call each)
curl "http://localhost:3000/api/anonyig/posts/nasa?pages=2"
curl http://localhost:3000/api/anonyig/reels/nasa
curl http://localhost:3000/api/anonyig/stories/nasa
curl http://localhost:3000/api/anonyig/highlights/nasa          # stories included
curl "http://localhost:3000/api/anonyig/highlights/nasa?withItems=false"

# EVERYTHING in one call — posts + stories + highlights + highlight stories —
# in the same converted JSON /api/user-feed returns, so existing clients of that
# response read this one unchanged
curl http://localhost:3000/api/anonyig/feed/nasa
curl "http://localhost:3000/api/anonyig/feed/nasa?pages=2&highlightDetailLimit=5"
curl "http://localhost:3000/api/anonyig/feed/nasa?includeHighlightDetails=false"

# the same data in the module's own normalized shape (adds anonyig's proxied and
# downloadable URL variants, which outlive the hot-link-protected CDN links)
curl http://localhost:3000/api/anonyig/profile/nasa
```

```bash
# what this host can reach + where the signing chunk stands
curl http://localhost:3000/api/anonyig/status
```

The signing chunk is fetched from anonyig.com on first use, then kept on disk. If
the hub starts rejecting signatures the module refetches by itself; to force it —
and to mirror it to B2 for hosts that cannot download it — run
`npm run anonyig:chunk`.

**On a deployed host this matters:** anonyig.com answers `HTTP 451` to hosts in
jurisdictions it refuses, so the download fails there and requests come back
`503 no usable anonyig signing chunk`. Publish the chunk once from a machine that
can reach the site (with the deployment's `B2_*` credentials) and every instance
reads it from B2 instead. See
[DEPLOY.md](DEPLOY.md#4-publish-the-anonyig-signing-chunk).

### 5.8 CSRF token (optional)

```bash
# fetch a fresh token, rotate + persist it
curl -X POST http://localhost:3000/api/auth-token

# read the currently stored token (no rotation)
curl http://localhost:3000/api/auth-token
```

---

## 6. Endpoint reference

| Method | Path                   | Purpose                                  |
| ------ | ---------------------- | ---------------------------------------- |
| GET    | `/health`              | health check                             |
| POST   | `/api/sessions`        | bulk add sessions (encrypted)            |
| GET    | `/api/sessions`        | list sessions (masked)                   |
| DELETE | `/api/sessions/:id`    | delete one session                       |
| DELETE | `/api/sessions`        | clear all sessions                       |
| POST   | `/api/proxies`         | bulk add proxies (creds encrypted)       |
| GET    | `/api/proxies`         | list proxies (no creds)                  |
| DELETE | `/api/proxies/:id`     | delete one proxy                         |
| DELETE | `/api/proxies`         | clear all proxies                        |
| POST   | `/api/user-feed`       | feed + stories/highlights (pool if no acct) |
| POST   | `/api/auth-token`      | fetch + rotate csrf token                |
| GET    | `/api/auth-token`      | read stored csrf token                   |
| POST   | `/api/instagram/search` | stories + highlights for a handle       |
| GET    | `/api/instagram/stories/:username` | same lookup, GET form        |
| GET    | `/api/instagram/highlights/:id` | media inside one highlight      |
| GET    | `/api/instagram/media` | media proxy / download (allow-listed CDNs) |
| POST   | `/api/instagram/download/zip` | zip a list of media items         |
| POST   | `/api/instagram/download/zip/start` | zip job (SSE progress)      |
| GET    | `/api/anonyig/user/:username` | user details (anonyig hub)        |
| GET    | `/api/anonyig/posts/:username` | posts (`?pages=`)                |
| GET    | `/api/anonyig/reels/:username` | reels (`?pages=`)                |
| GET    | `/api/anonyig/stories/:username` | active stories                 |
| GET    | `/api/anonyig/highlights/:username` | bubbles + their stories   |
| GET    | `/api/anonyig/feed/:username` | all of the above, converted JSON     |
| GET    | `/api/anonyig/profile/:username` | user + all four tabs           |
| GET    | `/api/anonyig/suggestions` | handle autocomplete (`?query=`)      |
| GET    | `/api/anonyig/status`  | reachability + signing-chunk diagnostics |
| GET    | `/admin`               | dashboard (pool, feed, stories)          |

---

## 7. Debugging a request

The server console always prints the raw Instagram JSON for each feed call
(`[getUserFeed] IG response ...`). For full request tracing, set `DEBUG_HTTP`:

```bash
DEBUG_HTTP=1 npm run dev
```

Then every outgoing request logs its URL, proxy, headers (Authorization,
csrftoken — truncated), cookies, and response status:

```
[HTTP →] GET https://i.instagram.com/api/v1/feed/user/44725523631/username/?count=12
  proxy: zproxy.lum-superproxy.io:22225
  headers: {... "Authorization":"Bearer IGT:2:eyJ…(173)"}
  cookies: sessionid=…; ds_user_id=…
[HTTP ←] GET ... → 200
```

Fastest loop (no server) — run the path directly:

```bash
DEBUG_HTTP=1 node -e 'require("dotenv").config();
const pool=require("./src/store/poolStore");
const {getUserFeed}=require("./src/services/instagram.service");
getUserFeed(pool.buildAccount({authToken:"YOUR_SESSIONID",proxy:"1.2.3.4:8080"}),"44725523631",{})
  .then(r=>console.log("edges:", r.data.user.edge_owner_to_timeline_media.edges.length));'
```

To capture in **Fiddler**, point the proxy at it: `"proxy":"127.0.0.1:8888"`,
enable *Decrypt HTTPS*, and start with `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## 8. Where data lives

- `data/pool.json` — encrypted sessions + proxies (git-ignored).
- `data/authToken.json` — current/rotated csrf token (git-ignored).
- `data/anonyig/live_link_chunk.js` — anonyig's request-signing chunk, downloaded
  on first use of `/api/anonyig/*` (git-ignored, third-party code — not
  redistributed here). Delete it or run `npm run anonyig:chunk` to refresh.
- `data/feeds/` — one JSON file per `/api/user-feed` call containing **only the
  converted result** (the `web_profile_info`-shaped response). Filename is
  `<timestamp>_<userId>_<id>.json` (git-ignored). No auth secrets are written.

Deleting these files resets the respective store. They are recreated on next
use.

## 9. Tests

```bash
npm test
```

## 10. Troubleshooting

- **`No auth provided ...`** — send an `authToken` (with optional `proxy`) in
  the body, or add a session via `POST /api/sessions`, or include a full
  `dominatorAccount`.
- **Empty feed / `502` but Instagram returns `200 ok`** — the proxy IP is being
  rate-limited/blocked by Instagram (`429`). Use a residential/mobile proxy and
  a fresh `sessionid`. Turn on `DEBUG_HTTP=1` to confirm the request is correct.
- **`curl: (56) Connection was reset`** — a stale/duplicate server is running.
  Free the port and start one server:
  ```powershell
  Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  ```
- **`[crypto] ENCRYPTION_KEY is not set` warning** — set `ENCRYPTION_KEY` in
  `.env` and restart. Note: changing the key makes previously stored secrets
  undecryptable (clear the pool and re-add them).
- **`EADDRINUSE` / Port already in use** — another server is on that port; free
  it (command above) or change `PORT` in `.env`.
- **Changes not taking effect** — restart nodemon (`Ctrl+C`, `npm run dev`). It
  watches only `src/` (writes to `data/` no longer trigger restarts).
