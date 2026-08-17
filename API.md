# API Payload Reference

Every endpoint in the project, with all accepted request-payload formats.

- Base URL (local): `http://localhost:3000`
- All request bodies are **JSON** — send `Content-Type: application/json`.
  (`application/x-www-form-urlencoded` is also parsed, but JSON is assumed below.)
- Three route groups:
  - **`/api/*`** — public, no authentication.
  - **`/api/instagram/*`** — stories, highlights and media downloads. Public, and
    it uses **no session and no proxy** (the sources are third-party story
    viewers, not Instagram's private API).
  - **`/api/anonyig/*`** — user details, posts, reels, stories and highlights
    from the anonyig worker hub. Public, and also **no session and no proxy**;
    see [anonyig payload](#anonyig-payload).
  - **`/admin/*`** — the dashboard. `/admin`, `/admin/status`, `/admin/login`,
    `/admin/user-feed`, `/admin/story-highlight` and `/admin/highlight-details`
    are **open**; everything else under `/admin` requires an admin token header
    (see [Admin auth](#admin-auth)).

---

## Route index

| Method | Path | Auth | Body |
| ------ | ---- | ---- | ---- |
| GET | `/health` | — | none |
| GET | `/admin` | — | none (serves dashboard HTML) |
| GET | `/admin/status` | — | none |
| POST | `/admin/login` | — | `{ passcode }` |
| POST | `/admin/logout` | token | none |
| POST | `/admin/user-feed` | — | [feed payload](#feed-payload) |
| GET | `/admin/user-feed` | — | [feed payload](#feed-payload) via query string |
| GET | `/admin/user-feed/:userId` | — | feed params via query string |
| GET | `/admin/sessions` | token | none |
| POST | `/admin/sessions` | token | [sessions payload](#sessions-payload) |
| PUT | `/admin/sessions/:id` | token | [session update](#session-update) |
| DELETE | `/admin/sessions/:id` | token | none (delete one) |
| DELETE | `/admin/sessions` | token | none (clear all) |
| GET | `/admin/proxies` | token | none |
| POST | `/admin/proxies` | token | [proxies payload](#proxies-payload) |
| POST | `/admin/proxies/:id/check` | token | none — tests the proxy, returns `{ ok, ms, status?, ip?, error? }` |
| PUT | `/admin/proxies/:id` | token | [proxy update](#proxy-update) |
| DELETE | `/admin/proxies/:id` | token | none (delete one) |
| DELETE | `/admin/proxies` | token | none (clear all) |
| POST | `/api/sessions` | — | [sessions payload](#sessions-payload) |
| GET | `/api/sessions` | — | none |
| DELETE | `/api/sessions/:id` | — | none (delete one) |
| DELETE | `/api/sessions` | — | none (clear all) |
| POST | `/api/proxies` | — | [proxies payload](#proxies-payload) |
| GET | `/api/proxies` | — | none |
| DELETE | `/api/proxies/:id` | — | none (delete one) |
| DELETE | `/api/proxies` | — | none (clear all) |
| POST | `/api/user-feed` | — | [feed payload](#feed-payload) |
| GET | `/api/user-feed` | — | [feed payload](#feed-payload) via query string |
| GET | `/api/user-feed/:userId` | — | feed params via query string |
| POST | `/api/auth-token` | — | `{ dominatorAccount? }` (optional) |
| GET | `/api/auth-token` | — | none |
| POST | `/admin/story-highlight` | — | [story payload](#story--highlight-payload) |
| GET | `/admin/story-highlight[/:username]` | — | story params via query string |
| GET | `/admin/highlight-details/:highlightId` | — | `?username=&userId=` |
| POST | `/api/instagram/search` | — | [story payload](#story--highlight-payload) |
| GET | `/api/instagram/search[/:username]` | — | story params via query string |
| GET | `/api/instagram/stories/:username` | — | alias of `search` |
| GET | `/api/instagram/story/:username` | — | alias of `search` |
| GET | `/api/instagram/highlights/:highlightId` | — | `?username=&userId=` |
| GET | `/api/instagram/media` | — | `?url=&filename=&inline=1` |
| POST | `/api/instagram/download/zip` | — | [zip payload](#zip-payload) |
| POST | `/api/instagram/download/zip/start` | — | [zip payload](#zip-payload) → `{ jobId }` |
| GET | `/api/instagram/download/zip/:jobId/events` | — | none (SSE progress) |
| GET | `/api/instagram/download/zip/:jobId/file` | — | none (the archive) |
| GET | `/api/anonyig/user[/:username]` | — | [anonyig payload](#anonyig-payload) via query string |
| POST | `/api/anonyig/user` | — | `{ username }` |
| GET | `/api/anonyig/posts/:username` | — | `?pages=` |
| GET | `/api/anonyig/reels/:username` | — | `?pages=` |
| GET | `/api/anonyig/stories/:username` | — | none |
| GET | `/api/anonyig/highlights/:username` | — | `?withItems=` |
| GET | `/api/anonyig/feed[/:username]` | — | `?pages=&includeHighlightDetails=&highlightDetailLimit=` |
| POST | `/api/anonyig/feed` | — | `{ username, pages?, includeHighlightDetails?, highlightDetailLimit? }` |
| GET | `/api/anonyig/profile[/:username]` | — | `?pages=&withHighlightItems=` |
| POST | `/api/anonyig/profile` | — | `{ username, pages?, withHighlightItems? }` |
| GET | `/api/anonyig/suggestions` | — | `?query=` |
| GET | `/api/anonyig/status` | — | none (diagnostics: host reachability + chunk state) |
| GET | `/api/fastdl` | — | [fastdl payload](#fastdl-payload) via query string |
| POST | `/api/fastdl` | — | [fastdl payload](#fastdl-payload) via body |
| GET | `/api/fastdl/:username` | — | `?pages=&includeHighlightDetails=&highlightDetailLimit=` |
| GET | `/api/fastdl/highlights/:highlightId` | — | none (stories inside one highlight bubble) |
| GET | `/api/fastdl/status` | — | none (diagnostics: host reachability + chunk state) |
| GET | `/api/graphql/:username` | — | [graphql payload](#graphql-payload) via path |
| GET | `/api/graphql` | — | [graphql payload](#graphql-payload) via query string |
| POST | `/api/graphql` | — | `{ username, first?, after? }` |


---

## Admin auth

`/admin/login` exchanges the passcode for a token:

```json
POST /admin/login
{ "passcode": "your-passcode" }
```

Response: `{ "success": true, "token": "<hex>", "idleMs": 30000 }`.

Send that token on token-gated `/admin/*` routes via **either** header:

```
x-admin-token: <token>
```
or
```
Authorization: Bearer <token>
```

The token slides on each use and auto-expires after 30s of inactivity (401
`Locked`). Note: `/admin/user-feed` is **not** gated — it needs no token.

---

## Sessions payload

Used by `POST /api/sessions` and `POST /admin/sessions`. The body may be any of
these four shapes:

```jsonc
// 1) An array of items
[ "<item>", "<item>" ]

// 2) A "sessions" key (array)
{ "sessions": [ "<item>", "<item>" ] }

// 3) A single item under "sessions"
{ "sessions": "<item>" }

// 4) A raw newline/comma-separated string under "raw" or "text"
{ "raw": "<item>\n<item>, <item>" }
```

Each **`<item>`** may be a string or an object:

**String forms**

```text
"64827392%3AAbCdEf...%3A17"                                  // raw sessionid
"sessionid=...; csrftoken=...; ds_user_id=...; mid=..."      // cookie string
```

**Object form** (all fields optional except a sessionid source)

```jsonc
{
  "sessionid": "64827392%3A...%3A17",   // or "sessionId"
  "csrftoken": "abc123",                // or "csrfToken"
  "mid": "xyz",
  "ds_user_id": "64827392",             // or "dsUserId" (auto-derived if omitted)
  "cookies": [                          // optional explicit cookie array
    { "name": "sessionid", "value": "...", "domain": "instagram.com" }
  ],
  "label": "acct-a"                     // optional
}
```

Notes:
- `ds_user_id` is auto-derived from the leading digits of the sessionid when not
  provided.
- Duplicates (same `sessionid`) are **skipped**.
- Bulk example:

```json
POST /api/sessions
{
  "sessions": [
    "64827392%3AAbCdEf...%3A17",
    "sessionid=99887766%3A...; csrftoken=abc; ds_user_id=99887766; mid=xyz",
    { "sessionid": "111%3A...", "label": "acct-3" }
  ]
}
```

### Session update

`PUT /admin/sessions/:id`. Partial update — send only what you want to change:

```jsonc
{
  "label": "renamed",                   // applied if the key is present (""=clear)
  "sessionid": "999%3ANEW%3A1"          // optional; if present, re-encrypts the
                                        // secret and refreshes ds_user_id
  // "cookies": [ ... ]                 // alternatively supply a cookie array
}
```

- Omit the credential fields to edit **only the label**.
- A bare string body is also accepted and treated as the new sessionid.

---

## Proxies payload

Used by `POST /api/proxies` and `POST /admin/proxies`. Same four container
shapes as sessions (array / `{ "proxies": [...] }` / single / `{ "raw"|"text" }`).

Each **`<item>`** may be a string or an object:

**String forms**

```text
"1.2.3.4:8080"                      // ip:port
"1.2.3.4:8080:user:pass"            // ip:port:user:pass
"user:pass@1.2.3.4:8080"            // user:pass@ip:port
"http://user:pass@1.2.3.4:8080"     // http:// or https:// prefix is stripped
```

**Object form**

```jsonc
{
  "host": "1.2.3.4",        // or "proxyIp" | "ip" | "url"
  "port": "8080",           // or "proxyPort"
  "username": "user",       // or "proxyUsername" | "user"  (optional)
  "password": "pass",       // or "proxyPassword" | "pass"  (optional)
  "label": "residential-us" // optional
}
```

**Luminati / Bright Data object** — username is built automatically as
`<customer>-zone-<zone>[-country-<country>][-session-<session>]`:

```jsonc
{
  "url": "zproxy.lum-superproxy.io",   // or "host"
  "port": 22225,
  "customer": "lum-customer-c_e11f9742",
  "zone": "residntzone",
  "country": "us",                      // optional → adds -country-us
  "session": "abc123",                  // optional → adds -session-abc123 (sticky IP)
  "password": "n0oioikax2i2",
  "label": "lum-residential"
}
```

Notes:
- `host` and `port` are required (per item); items missing either are skipped.
- Duplicates (same `host:port:username`) are **skipped**.

### Proxy update

`PUT /admin/proxies/:id`. Partial update:

```jsonc
{
  "label": "px2",           // applied if present ("" = clear)
  "host": "5.6.7.8",        // if present, re-encrypts credentials + refreshes host/port
  "port": "9090",
  "username": "newuser",    // optional
  "password": "newpass"     // optional
}
```

- Omit `host` to edit **only the label**.
- A proxy string (e.g. `"5.6.7.8:9090:u:p"`) is also accepted as the whole body.

---

## Feed payload

Used by `/api/user-feed` and `/admin/user-feed`, available as **POST** (JSON
body, shown below) or **GET** (same fields via the query string, or `userId` as
a path segment):

```text
GET /api/user-feed?userId=incindia            # username works
GET /api/user-feed?userId=7425066841          # or a numeric id
GET /api/user-feed/incindia                   # userId as a path param
GET /admin/user-feed?userId=incindia          # same, open (no token)
```

`userId` accepts an Instagram **username** (e.g. `incindia`, `wwe`) or a numeric
user id — both resolve the same feed.

Precedence when both are present: JSON body → query string → path param.
Complex values (a full `dominatorAccount`, a proxy **object**) require POST; via
GET use the string proxy forms. ⚠️ Passing `authToken`/`proxy` credentials in a
GET URL exposes them in server/proxy logs and browser history — prefer POST, or
the pool (`?userId=` only), when secrets are involved.

The POST JSON body:

```jsonc
{
  "userId": "incindia",            // REQUIRED — Instagram username OR numeric user id

  // ---- pick ONE auth source, or none to use the stored pool ----
  "authToken": "<sessionid>",      // or "sessionid" | "token"
  "csrfToken": "...",              // optional, pairs with authToken
  "proxy": "1.2.3.4:8080:user:pass", // optional; string OR any proxy object
                                     // (same formats as the proxies payload)
  // ---- or a full legacy account ----
  "dominatorAccount": {            // optional; overrides the above
    "cookies": [ { "name": "sessionid", "value": "...", "domain": "instagram.com" } ],
    "accountBaseModel": {
      "accountProxy": {
        "proxyIp": "1.2.3.4", "proxyPort": "8080",
        "proxyUsername": "user", "proxyPassword": "pass"
      }
    }
  },

  "maxId": null,                   // optional pagination cursor

  // ---- stories & highlights (merged into the same response) ----
  "includeStories": true,          // default: FEED_INCLUDE_STORIES (true)
  "includeHighlightDetails": true, // default: FEED_INCLUDE_HIGHLIGHT_DETAILS (true)
  "highlightDetailLimit": 0        // default: FEED_HIGHLIGHT_DETAIL_LIMIT (0 = every highlight)
}
```

`POST /api/user-feed` additionally accepts two optional passthrough fields:

```jsonc
{
  "minTimestamp": null,            // optional
  "isNewBrowser": false            // optional
}
```

Resolution order for auth/proxy: `dominatorAccount` → inline
`authToken`/`proxy` → the encrypted pool (round-robin). If nothing is supplied
and the pool has no sessions, the request is rejected (`400`). If auth exists but
no proxy anywhere, the request goes **direct**.

Minimal examples:

```json
// Simplest — everything from the pool
{ "userId": "incindia" }
```
```json
// Inline auth + proxy
{ "userId": "incindia",
  "authToken": "64827392%3AAbCdEf...%3A17",
  "proxy": "1.2.3.4:8080:user:pass" }
```

`/admin/user-feed` response is wrapped:
`{ success, ok, userId, username, count, storyCount, highlightCount, result }` —
where `result` is the converted `web_profile_info` object. `/api/user-feed`
returns the `result` object directly (HTTP `200` with posts, `502` when empty).

### Stories & highlights in the feed response

When the story lookup runs (the default), the converted JSON carries three extra
top-level nodes next to `data` and `status`. They are always present once the
lookup ran — an empty result reports `available: false` plus the reason in
`error`, so the response shape stays stable:

```jsonc
{
  "data":   { "user": { /* …web_profile_info… */ } },
  "status": "ok",

  "stories": {
    "available": true,
    "count": 2,
    "source": "anonstories",         // "storynavigation" | "anonstories" | "browser" | null
    "error": null,
    "items": [
      {
        "username": "instagram",
        "type": "video",
        "storyUrl": "https://…",     // image / thumbnail
        "videoUrl": "https://…",     // null for photos
        "isVideo": true,
        "createdAt": "30-07-2026 12:15:16 AM",
        "storyDate": "30-07-2026 12:15:16 AM"
      }
    ]
  },

  "highlights": {
    "available": true,
    "count": 6,
    "source": "storynavigation",     // resolved independently of stories.source
    "error": null,
    "items": [
      {
        "id": "18142207969557132",
        "title": "creatives",
        "coverUrl": "https://…",
        "username": "instagram",
        "itemCount": 39              // null when this bubble was not expanded
      }
    ]
  },

  // Only present when includeHighlightDetails is on (it is by default).
  "highlight_details": {
    "available": true,
    "count": 6,                      // bubbles expanded
    "truncated": false,              // true if a limit left some unexpanded
    "error": null,
    // ONE NODE PER HIGHLIGHT, KEYED BY HIGHLIGHT ID.
    "items": {
      "18142207969557132": {
        "id": "18142207969557132",
        "title": "creatives",
        "coverUrl": "https://…",
        "source": "storynavigation",
        "count": 39,
        "error": null,
        "items": [
          {
            "mediaUrl": "https://…",
            "videoUrl": null,
            "type": "image",
            "isVideo": false,
            "created": "07-06-2026 07:56:27 PM"
          }
        ]
      },
      "18029499352961095": { "id": "18029499352961095", "title": "what’s new", "count": 36, "items": [ … ] }
    }
  }
}
```

Reading one highlight's media is therefore a direct lookup — no scanning:

```js
const id = feed.highlights.items[0].id;
const media = feed.highlight_details.items[id].items;   // [{ mediaUrl, videoUrl, … }]
```

Notes:

- **Sources fall back independently.** Stories and highlights are each fetched
  from storynavigation.com and, when that yields nothing, from anonstories.com —
  so `stories.source` and `highlights.source` frequently differ (one account may
  serve stories from anonstories and highlights from storynavigation). The
  decision is made on whether a payload actually **parsed into items**, not on
  its raw body, because storynavigation reports failure inconsistently
  (`{"message":"CSRF token mismatch."}` on a dead session, `[]` for an account it
  cannot read, an HTML page when rate-limited). `source: null` means neither
  source returned anything — for stories that usually just means none are active.
- The profile is likewise salvaged from whichever payload carried it:
  storynavigation's `accountInfo`, else the `user_info` object inside the
  anonstories story or highlight response.
- **anonstories throttles hard** — roughly five rapid requests earn `HTTP 429`,
  and pushing further earns an HTML block page — yet for some accounts (`wwe`,
  for instance, whose storynavigation highlight list is `[]`) it is the only
  source of the highlight list. Requests to it are therefore serialized with
  `STORY_ANON_MIN_INTERVAL_MS` (900ms) between them and cached for
  `STORY_ANON_CACHE_TTL_MS` (60s), plus one `STORY_RETRY_DELAY_MS` (3s) backoff
  retry on a 429. When it still refuses, the reason says so verbatim —
  `"anonstories: HTTP 429 — Too many requests"` — which is a *transient* failure,
  not "this account has no highlights". Retry after a minute.
- The two sources also differ in **coverage**: they only know the highlights they
  have crawled. `wwe` resolves 1 bubble even though the account has more, and
  some accounts (`natgeo`) resolve none at all while both sources answer
  perfectly validly (`error: null`). Nothing in the fallback chain can invent
  data neither viewer holds.
- The lookup keys off a **username**. A numeric `userId` is fine — the handle is
  taken from the feed response; a username input starts the story lookup in
  parallel with the feed.
- **Every highlight is expanded by default** (`FEED_HIGHLIGHT_DETAIL_LIMIT=0`).
  That is one upstream call per bubble, run `FEED_HIGHLIGHT_DETAIL_CONCURRENCY`
  (5) at a time, so an account with dozens of highlights makes the request
  noticeably slower — set a positive `highlightDetailLimit` to bound it, and the
  response then reports `highlight_details.truncated: true`.
- Set `includeStories: false` to skip the lookup entirely; the response then has
  no story nodes at all.

---

## Story & highlight payload

`POST /api/instagram/search` and `POST /admin/story-highlight` (also available as
GET with the same fields in the query string, or the handle as a path segment):

```text
GET /api/instagram/search?username=instagram
GET /api/instagram/search/instagram
GET /api/instagram/stories/instagram
GET /api/instagram/story/instagram
GET /admin/story-highlight/instagram
```

```jsonc
{
  "username": "instagram",          // REQUIRED — handle, @handle, or profile URL
  "includeHighlightDetails": true,  // DEFAULT — expands every bubble in the same response
  "highlightDetailLimit": 0         // DEFAULT — 0 = all; a positive n expands only the first n
}
```

Both endpoints expand all highlights automatically, so `GET
/api/instagram/search?username=instagram` alone returns the profile, stories,
highlight bubbles **and** every bubble's media. Send
`includeHighlightDetails=false` when you only want the bubbles.

- `/api/instagram/search` responds
  `{ success, status, source, highlightSource, storiesError, highlightsError,
  data, highlight_details }`, where `data` is the story model (`username`,
  `fullName`, `profilePic`, `isPrivate`, counts, `stories[]`, `highlights[]`) and
  `highlight_details` is the id-keyed node shown above. `source` covers the
  stories and `highlightSource` the highlight list — see the note above on why
  they differ.
- `/admin/story-highlight` responds wrapped like the admin feed:
  `{ success, ok, username, source, highlightSource, storyCount,
  highlightCount, truncated, reason, result }` with
  `result = { profile, stories, highlights, highlight_details }`.
- `GET /api/instagram/highlights/:highlightId?username=&userId=` returns one
  bubble's media: `{ success, source, title, count, data[] }`. `userId` is the
  numeric Instagram id and is only needed for the anonstories fallback.

---

## anonyig payload

`/api/anonyig/*` fetches a public handle's profile data from the anonyig worker
hub — a different upstream from the story viewers behind `/api/instagram/*`, with
its own signed HTTP/2 transport. It needs no session, no proxy and no setup;
implementation notes are in [src/anonyig/README.md](src/anonyig/README.md).

The handle is read from the path, the query string or the body, so these are the
same call:

```text
GET  /api/anonyig/user/nasa
GET  /api/anonyig/user?username=@nasa
POST /api/anonyig/user      {"username": "nasa"}
```

### User details

`GET /api/anonyig/user/:username` — one upstream call, cached in-process for
`ANONYIG_USER_CACHE_TTL_MS`:

```jsonc
{
  "success": true,
  "source": "anonyig",
  "data": {
    "id": "528817151",
    "username": "nasa",
    "fullName": "NASA",
    "biography": "Making the seemingly impossible, possible. ✨",
    "isPrivate": false,
    "isVerified": true,
    "followers": 104258106,
    "following": 92,
    "postCount": 4863,
    "externalUrl": "https://www.nasa.gov",
    "category": "",
    "profilePic": "https://scontent-…cdninstagram.com/…",   // direct CDN link
    "profilePicProxied": "https://media.anonyig.com/get?…"  // hot-link-safe mirror
  }
}
```

### Tabs

| Request | Response |
| ------- | -------- |
| `GET /posts/:username?pages=1` | `{ success, source, count, pages, pageInfo, data[] }` — carousels expand to one entry per child |
| `GET /reels/:username?pages=1` | same shape, filtered to entries with a video URL |
| `GET /stories/:username` | `{ success, source, count, data[] }` — active stories, `[]` when there are none |
| `GET /highlights/:username?withItems=true` | `{ success, source, count, data[] }` — each bubble carries its own `items[]` |

`pages` follows `end_cursor` pagination: one page is ~12 posts and one upstream
call, clamped to `ANONYIG_MAX_PAGES` (default 10). `withItems=false` returns
highlight covers and titles only — one call instead of one per highlight. A
highlight that failed on its own comes back with `items: []` and `error`.

Post entries carry `id`, `shortcode`, `url`, `type`, `isVideo`, `caption`,
`takenAt` (ms), `likeCount`, `commentCount`, `viewCount`, dimensions,
`carouselIndex`/`carouselCount`, and three URL flavours per medium: direct
(`imageUrl`, `videoUrl`), proxied (`…Proxied`) and attachment (`…Download`).
Story items use the same convention.

### Everything, in the converted format

`GET /api/anonyig/feed/:username` is the single call for **posts, stories,
highlight bubbles and the stories inside every bubble** — returned in the same
converted JSON as [the feed payload](#feed-payload):

```jsonc
{
  "data": { "user": {
    "id": "528817151", "username": "nasa", "full_name": "NASA",
    "is_private": false, "is_verified": true,
    "profile_pic_url": "…", "profile_pic_url_hd": "…",
    "edge_followed_by": { "count": 104258106 },
    "edge_follow": { "count": 92 },
    "edge_owner_to_timeline_media": {
      "count": 4863,                                    // total posts on the account
      "page_info": { "has_next_page": true, "end_cursor": "QVFE…" },
      "edges": [ { "node": { "__typename": "GraphVideo", "shortcode": "…", … } } ]
    }
  } },
  "status": "ok",
  "source": "anonyig",
  "errors": null,          // per-part failures when there were any, e.g. { "stories": "…" }
  "stories":     { "available": true, "count": 4, "source": "anonyig", "error": null,
                   "items": [ { "username", "type", "storyUrl", "videoUrl",
                                "createdAt", "storyDate", "isVideo" } ] },
  "highlights":  { "available": true, "count": 4, "source": "anonyig", "error": null,
                   "items": [ { "id", "title", "coverUrl", "username", "itemCount" } ] },
  "highlight_details": {
    "available": true, "count": 4, "truncated": false, "error": null,
    "items": { "18201653992314974": { "id", "title", "coverUrl", "username",
                                      "source", "count", "error",
                                      "items": [ { "mediaUrl", "videoUrl",
                                                   "type", "isVideo", "created" } ] } }
  }
}
```

The post nodes are the same 30-key node the feed emits — carousel children under
`edge_sidecar_to_children`, the `thumbnail_resources` ladder, `edge_liked_by` /
`edge_media_preview_like`, `video_url` + `dash_info` on videos. The story,
highlight and highlight-detail items match what `/api/instagram/*` returns, down
to the numeric highlight ids. **An existing consumer of `/api/user-feed` reads
this response unchanged** — only the source differs (one upstream, no session, no
proxy, and no `data/feeds/` log entry).

| Parameter | Default | |
| --------- | ------- | - |
| `pages` | `1` | post pages to walk, ~12 posts each; capped by `ANONYIG_MAX_PAGES` |
| `includeHighlightDetails` | `true` | `false` returns bubbles only and drops the `highlight_details` node — one call instead of one per highlight |
| `highlightDetailLimit` | `0` | `0` expands every bubble; a positive n expands the first n and sets `truncated: true` |

Nodes carry Instagram's own CDN links, which are hot-link protected and expire.
Use `/profile` below when you also want anonyig's proxied and downloadable
variants of every URL.

### Whole profile (module-native shape)

`GET /api/anonyig/profile/:username?pages=1&withHighlightItems=true` returns the
same data in the module's own normalized shape, tabs fetched concurrently over a
single connection:

```jsonc
{
  "success": true,
  "source": "anonyig",
  "errors": null,               // per-tab failures, e.g. { "stories": "…" }
  "fetchedAt": "2026-07-31T09:12:04.771Z",
  "data": {
    "user":       { /* as above */ },
    "posts":      { "items": [], "count": 17, "pages": 1, "pageInfo": {} },
    "reels":      { "items": [], "count": 6, "pageInfo": {} },
    "stories":    { "items": [], "count": 4 },
    "highlights": { "items": [], "count": 4 }
  }
}
```

A tab that fails (private account, no stories) is named in `errors` instead of
failing the request, so a partial profile still comes back. Reels cost no extra
call — they are the posts payload filtered by video URL.

`GET /api/anonyig/suggestions?query=nas` returns the site's handle autocomplete:
`{ success, source, count, data[] }`.

### Errors

`400` missing or malformed handle · `404` no such account · `429` the hub is
throttling this client · `504` upstream timeout · `502` anything else upstream ·
`503` no signing chunk available (see below). The hub's own status is never
replayed as this API's, and its `code` is folded into the message:

```json
{ "success": false, "error": "anonyig upstream failure (CAPTCHA_REQUIRED): …" }
```

### Diagnostics

`GET /api/anonyig/status` reports whether this host can reach `anonyig.com` (the
signing chunk) and `api-wh.anonyig.com` (the data), plus where the chunk stands —
on disk, mirrored to B2, and whether it currently signs. `verdict` is a
one-liner naming the fix.

This matters because the two hosts gate independently, and a deployed instance
hits both:

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `503 no usable anonyig signing chunk` | anonyig.com answers `451` to hosts in jurisdictions it refuses | publish the chunk from a machine that can reach it: `npm run anonyig:chunk` mirrors it to the B2 bucket every instance reads — [DEPLOY.md §4](DEPLOY.md#4-publish-the-anonyig-signing-chunk) |
| `502 … serving a captcha challenge` (`CAPTCHA_REQUIRED`) | the hub distrusts the host's address — every datacenter range is distrusted | route the hub through a residential proxy: `ANONYIG_PROXY` or `ANONYIG_USE_POOL_PROXY=true` — [DEPLOY.md §5](DEPLOY.md#5-give-the-anonyig-module-a-proxy) |
| `502 proxy … refused CONNECT` | the configured proxy is unreachable, has bad credentials, or will not speak HTTP/2 | the message names which |

Neither is visible locally — a developer machine passes both gates — so `/status`
is how a deployed instance reports which one it is behind.

---

## fastdl payload

`/api/fastdl` is a consolidated single-hit endpoint that fetches either:
1. **Media Details**: Direct download URLs, thumbnails, and metadata for a single Instagram post, reel, story, or highlight link (when given a post/media URL).
2. **Converted Profile Feed**: Profile details, posts, active stories, highlight bubbles, and highlight stories mapped to the converted feed shape (when given an Instagram handle or profile URL).
3. **Highlight Stories**: Direct media items inside a single highlight bubble (when given a numeric highlight ID or `highlight:<id>`).

Additionally, `GET /api/fastdl/highlights/:highlightId` fetches the constituent stories for a single highlight bubble directly.

The target parameter (URL, handle, or highlight ID) is read from the query string, body, or path, using any of the following keys:
`url`, `sf_url`, `link`, `username`, `instaUsername`, `handle`, or `highlightId`.


```text
GET  /api/fastdl?url=https://www.instagram.com/p/DbbY9pdm6Q2/
GET  /api/fastdl/nasa?highlightDetailLimit=1
POST /api/fastdl      {"handle": "nasa"}
```

### Media Details Response

When given a post URL, the response wraps FastDL's normalized media results list under a `data` node:

```jsonc
{
  "success": true,
  "source": "fastdl",
  "data": [
    {
      "url": [
        {
          "url": "https://scontent-…cdninstagram.com/…",  // direct download link
          "name": "MP4",
          "type": "video",
          "ext": "mp4"
        }
      ],
      "meta": {
        "title": "NASA post caption...",
        "source": "https://www.instagram.com/api/v1/users/web_profile_info/?username=nasa",
        "shortcode": "Dbd3EBdnW_u",
        "comment_count": 179,
        "like_count": 51872,
        "taken_at": 1785520896,
        "username": "nasa"
      },
      "thumb": "https://media.fastdl.app/get?__sig=...",
      "sd": {
        "url": "https://scontent-..."
      }
    }
  ]
}
```

### Converted Profile Feed Response

When given a handle or profile URL, it fetches user info, posts, active stories, highlight bubbles, and highlight stories concurrently over HTTP/2, returning them in the converted JSON shape (exactly mirroring `/api/anonyig/feed` and `/api/user-feed`):

```jsonc
{
  "data": { "user": {
    "id": "528817151", "username": "nasa", "full_name": "NASA",
    "is_private": false, "is_verified": true,
    "profile_pic_url": "…", "profile_pic_url_hd": "…",
    "edge_followed_by": { "count": 104258106 },
    "edge_follow": { "count": 92 },
    "edge_owner_to_timeline_media": {
      "count": 4863,
      "page_info": { "has_next_page": true, "end_cursor": "QVFE…" },
      "edges": [ { "node": { "__typename": "GraphVideo", "shortcode": "…", … } } ]
    }
  } },
  "status": "ok",
  "source": "fastdl",
  "errors": null,
  "stories":     { "available": true, "count": 4, "source": "fastdl", "error": null,
                   "items": [ { "username", "type", "storyUrl", "videoUrl", "createdAt", "storyDate", "isVideo" } ] },
  "highlights":  { "available": true, "count": 4, "source": "fastdl", "error": null,
                   "items": [ { "id", "title", "coverUrl", "username", "itemCount" } ] },
  "highlight_details": {
    "available": true, "count": 4, "truncated": false, "error": null,
    "items": { "18201653992314974": { "id", "title", "coverUrl", "username", "source", "count", "error",
                                      "items": [ { "mediaUrl", "videoUrl", "type", "isVideo", "created" } ] } }
  }
}
```

| Parameter | Default | |
| --------- | ------- | - |
| `pages` | `1` | post pages to walk, ~12 posts each; capped by `FASTDL_MAX_PAGES` (inherited/clamped) |
| `includeHighlightDetails` | `true` | `false` returns bubbles only and drops the `highlight_details` node |
| `highlightDetailLimit` | `0` | `0` expands every bubble; a positive n expands the first n and sets `truncated: true` |

### Diagnostics

`GET /api/fastdl/status` reports whether this host can reach `fastdl.app` (the signing chunk) and `api-wh.fastdl.app` (the data), plus where the chunk stands — on disk, mirrored to B2, and whether it currently signs.

---

## graphql payload

`/api/graphql` fetches an Instagram user's timeline posts directly via the
official Instagram GraphQL query (`doc_id=7950326061742207`) that the web
app itself uses. Unlike `/api/user-feed` it does **not** use the mobile
private API — it hits the same public GraphQL surface the browser calls,
so its response nodes carry the full `web_profile_info` edge shape verbatim.

**Requires**: a valid session in the pool — an unauthenticated request
returns empty edges (Instagram gates the query on auth).

The handle is read from the path, query string, or JSON body:

```text
GET  /api/graphql/nasa
GET  /api/graphql?username=nasa&first=12
POST /api/graphql    { "username": "nasa", "first": 12 }
```

### How it works

1. **Resolve user ID** — calls `web_profile_info?username=<handle>` (public,
   no session) to obtain the numeric Instagram user id (e.g. `"28527810"`).
2. **Run the GraphQL query** — calls
   `GET /graphql/query/?doc_id=7950326061742207&variables={"id":"…","first":12}`
   using the pool session's auth headers.
3. **Return** — the response wraps the raw GraphQL nodes inside a standard
   envelope so existing consumers of `/api/user-feed` can read it unchanged.

### Parameters

| Parameter | Source | Default | Notes |
| --------- | ------ | ------- | ----- |
| `username` | path / query / body | — | **Required.** Handle (with or without `@`) |
| `first` | query / body | `12` | Posts per page, clamped to 50 |
| `after` (or `endCursor`) | query / body | — | Pagination cursor from a prior `endCursor` |

### Response

```jsonc
{
  "success": true,
  "source": "graphql",
  "userId": "28527810",
  "username": "nasa",
  "count": 12,                          // posts in this page
  "totalCount": 4863,                   // total posts on the account
  "hasNextPage": true,
  "endCursor": "QVFE…",                 // pass as `after` to fetch the next page
  "data": {
    "user": {
      "id": "28527810",
      "username": "nasa",
      "edge_owner_to_timeline_media": {
        "count": 4863,
        "page_info": { "has_next_page": true, "end_cursor": "QVFE…" },
        "edges": [
          {
            "node": {
              "__typename": "GraphImage",   // GraphImage | GraphVideo | GraphSidecar
              "id": "3945611671337605949",
              "shortcode": "DbbY9pdm6Q2",
              "dimensions": { "height": 1080, "width": 1080 },
              "display_url": "https://instagram.f….fbcdn.net/…",
              "display_resources": [
                { "src": "…", "config_width": 640, "config_height": 640 },
                { "src": "…", "config_width": 750, "config_height": 750 },
                { "src": "…", "config_width": 1080, "config_height": 1080 }
              ],
              "is_video": false,
              "video_url": null,              // present on GraphVideo nodes
              "edge_media_to_tagged_user": { "edges": [] },
              "edge_media_to_caption": { "edges": [{ "node": { "text": "…" } }] },
              "edge_liked_by": { "count": 51872 },
              "edge_media_to_comment": { "count": 179 },
              "taken_at_timestamp": 1785520896,
              "accessibility_caption": null,
              "has_upcoming_event": false,
              "gating_info": null,
              "sharing_friction_info": { "should_have_sharing_friction": false }
            }
          }
        ]
      }
    }
  },
  "status": "ok"
}
```

Pagination example — fetch the second page using the cursor from the first:

```text
GET /api/graphql/nasa?first=12&after=QVFE…
```

### Errors

`400` missing username · `404` username could not be resolved to an ID ·
`502` Instagram GraphQL upstream failure (session expired, rate-limited,
or the account is private) · `503`/`401` no usable pool session.

---

## Zip payload

`POST /api/instagram/download/zip` streams the archive; `…/zip/start` returns
`{ jobId }` so progress can be followed over SSE
(`…/zip/:jobId/events`) before fetching `…/zip/:jobId/file`.

```jsonc
{
  "username": "instagram",         // names the zip and the entries
  "items": [
    {
      "url": "https://…",          // REQUIRED — must be an allow-listed CDN host
      "type": "video",             // optional, picks the file extension
      "kind": "highlight",         // "story" (default) | "highlight" | "profile"
      "highlightId": "1814…",      // optional, for kind: "highlight"
      "highlightTitle": "creatives", // optional, names the subfolder
      "filename": "custom.jpg"     // optional, overrides the generated entry path
    }
  ]
}
```

Entries are laid out as `<user>.jpg` (profile), `Stories/<user>_Story_<n>.<ext>`
and `Highlights/<Title>/<user>_<Title>_<n>.<ext>`. Media that could not be
fetched (CDN links expire quickly) is listed in `_failed.txt` inside the archive.
`STORY_MAX_ZIP_ITEMS` (default 300) caps `items`.

`GET /api/instagram/media?url=…` proxies a single file — add `&inline=1` to
preview it in a browser instead of downloading, or `&filename=…` to name the
download. Only Instagram/Facebook CDNs and the story sources are allowed; any
other host is rejected with `403`.

---

## auth-token payload

`POST /api/auth-token` — fetches a fresh CSRF token, rotates + persists it.
Body is **optional**:

```jsonc
{
  "dominatorAccount": { ... }      // optional cookies/proxy context (see feed payload)
}
```

`GET /api/auth-token` — no body; returns the currently stored token (or `404`).

---

## Endpoints with no request body

`GET /health`, `GET /admin`, `GET /admin/status`, `GET /admin/sessions`,
`GET /admin/proxies`, `GET /api/sessions`, `GET /api/proxies`,
`GET /api/auth-token`, `POST /admin/logout`, the `GET` story/media routes
(`/api/instagram/media`, `/api/instagram/highlights/:id`, the zip
`events`/`file` routes), and all `DELETE` routes take **no body**. For `DELETE`, omitting the `:id` clears the whole collection
(e.g. `DELETE /api/sessions` removes all sessions).
