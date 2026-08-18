# GetIGFeed — Master API Reference

Complete reference for every route group, request shape, and response payload.

- **Base URL (local):** `http://localhost:3000`
- **Base URL (production):** your Render / custom deployment URL
- **Request bodies:** JSON — send `Content-Type: application/json`
  (`application/x-www-form-urlencoded` is also parsed transparently)
- **Response bodies:** always JSON

---

## Table of Contents

1. [Route Groups](#1-route-groups)
2. [Complete Route Index](#2-complete-route-index)
3. [Admin Authentication](#3-admin-authentication)
4. [Sessions](#4-sessions)
5. [Proxies](#5-proxies)
6. [User Feed — `/api/user-feed`](#6-user-feed--apiuser-feed)
7. [Stories & Highlights — `/api/instagram`](#7-stories--highlights--apiinstagram)
8. [Zip Download — `/api/instagram/download/zip`](#8-zip-download--apiinstagramdownloadzip)
9. [Auth Token — `/api/auth-token`](#9-auth-token--apiauth-token)
10. [Anonyig — `/api/anonyig`](#10-anonyig--apianonyig)
11. [FastDL — `/api/fastdl`](#11-fastdl--apifastdl)
12. [GraphQL Timeline — `/api/graphql`](#12-graphql-timeline--apigraphql)
13. [Shared Response Shapes](#13-shared-response-shapes)
14. [Error Reference](#14-error-reference)
15. [Environment Variables](#15-environment-variables)

---

## 1. Route Groups

| Prefix | Auth required | Session / proxy needed | Description |
|---|---|---|---|
| `/health` | — | no | liveness check |
| `/admin/*` | admin token (most routes) | optional | dashboard UI + pool management |
| `/api/*` | — | varies | public data endpoints |
| `/api/instagram/*` | — | **no** | third-party story viewers, no IG session |
| `/api/anonyig/*` | — | **no** | anonyig worker hub, signed HTTP/2 |
| `/api/fastdl/*` | — | **no** | fastdl.app signed HTTP/2 |
| `/api/graphql/*` | — | **yes** (pool) | official IG GraphQL query |
| `/api/user-feed` | — | **yes** (pool or inline) | IG private mobile API |

---

## 2. Complete Route Index

### System

| Method | Path | Auth | Body |
|---|---|---|---|
| GET | `/health` | — | none → `{ status: "ok" }` |

### Admin

| Method | Path | Auth | Body |
|---|---|---|---|
| GET | `/admin` | — | none (serves dashboard HTML) |
| GET | `/admin/status` | — | none |
| POST | `/admin/login` | — | `{ passcode }` |
| POST | `/admin/logout` | token | none |
| POST | `/admin/user-feed` | — | [feed payload](#6-user-feed--apiuser-feed) |
| GET | `/admin/user-feed[/:userId]` | — | feed params via query string |
| POST | `/admin/story-highlight` | — | [story payload](#7-stories--highlights--apiinstagram) |
| GET | `/admin/story-highlight[/:username]` | — | story params via query string |
| GET | `/admin/highlight-details/:highlightId` | — | `?username=&userId=` |
| GET | `/admin/sessions` | token | none |
| POST | `/admin/sessions` | token | [sessions payload](#4-sessions) |
| PUT | `/admin/sessions/:id` | token | [session update](#session-update) |
| DELETE | `/admin/sessions/:id` | token | none |
| DELETE | `/admin/sessions` | token | none (clear all) |
| GET | `/admin/proxies` | token | none |
| POST | `/admin/proxies` | token | [proxies payload](#5-proxies) |
| POST | `/admin/proxies/:id/check` | token | none → `{ ok, ms, status?, ip?, error? }` |
| PUT | `/admin/proxies/:id` | token | [proxy update](#proxy-update) |
| DELETE | `/admin/proxies/:id` | token | none |
| DELETE | `/admin/proxies` | token | none (clear all) |

### Public API

| Method | Path | Auth | Body |
|---|---|---|---|
| POST | `/api/sessions` | — | [sessions payload](#4-sessions) |
| GET | `/api/sessions` | — | none |
| DELETE | `/api/sessions/:id` | — | none |
| DELETE | `/api/sessions` | — | none (clear all) |
| POST | `/api/proxies` | — | [proxies payload](#5-proxies) |
| GET | `/api/proxies` | — | none |
| DELETE | `/api/proxies/:id` | — | none |
| DELETE | `/api/proxies` | — | none (clear all) |
| POST | `/api/auth-token` | — | `{ dominatorAccount? }` |
| GET | `/api/auth-token` | — | none |
| POST | `/api/user-feed` | — | [feed payload](#6-user-feed--apiuser-feed) |
| GET | `/api/user-feed[/:userId]` | — | feed params via query string |
| POST | `/api/instagram/search` | — | [story payload](#request-body-1) |
| GET | `/api/instagram/search[/:username]` | — | story params via query string |
| GET | `/api/instagram/stories/:username` | — | alias of search |
| GET | `/api/instagram/highlights/:highlightId` | — | `?username=&userId=` |
| GET | `/api/instagram/media` | — | `?url=&filename=&inline=1` |
| POST | `/api/instagram/download/zip` | — | [zip payload](#8-zip-download--apiinstagramdownloadzip) |
| POST | `/api/instagram/download/zip/start` | — | zip payload → `{ jobId }` |
| GET | `/api/instagram/download/zip/:jobId/events` | — | none (SSE stream) |
| GET | `/api/instagram/download/zip/:jobId/file` | — | none (archive download) |
| GET | `/api/anonyig/user[/:username]` | — | [anonyig payload](#10-anonyig--apianonyig) |
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
| GET | `/api/anonyig/status` | — | none |
| GET | `/api/fastdl[/:username]` | — | [fastdl payload](#11-fastdl--apifastdl) |
| POST | `/api/fastdl` | — | `{ url? \| handle?, pages?, includeHighlightDetails?, highlightDetailLimit? }` |
| GET | `/api/fastdl/highlights/:highlightId` | — | none |
| GET | `/api/fastdl/status` | — | none |
| GET | `/api/graphql[/:username]` | — | [graphql payload](#12-graphql-timeline--apigraphql) |
| POST | `/api/graphql` | — | `{ username, first?, after? }` |

---

## 3. Admin Authentication

`POST /admin/login` exchanges a passcode for a sliding session token:

```jsonc
// Request
POST /admin/login
{ "passcode": "your-passcode" }

// Response
{ "success": true, "token": "<hex-64>", "idleMs": 30000 }
```

Send the token on every gated `/admin/*` route via **either** header:

```
x-admin-token: <token>
Authorization: Bearer <token>
```

The token auto-expires after **30 s of inactivity** (`401 Locked`). Each use resets the timer. `/admin/user-feed`, `/admin/story-highlight`, and `/admin/highlight-details` are **open** — they need no token.

---

## 4. Sessions

Used by `POST /api/sessions` and `POST /admin/sessions`.

### Container shapes (any of four)

```jsonc
// 1. Array of items
[ "<item>", "<item>" ]

// 2. Named key (array)
{ "sessions": [ "<item>", "<item>" ] }

// 3. Named key (single)
{ "sessions": "<item>" }

// 4. Raw newline/comma text
{ "raw": "<item>\n<item>, <item>" }
```

### Item formats

**String — raw sessionid**
```
64827392%3AAbCdEf...%3A17
```

**String — cookie string**
```
sessionid=...; csrftoken=...; ds_user_id=...; mid=...
```

**Object**
```jsonc
{
  "sessionid": "64827392%3A...%3A17",   // required (also: "sessionId")
  "csrftoken": "abc123",                // optional (also: "csrfToken")
  "mid": "xyz",                         // optional
  "ds_user_id": "64827392",             // optional; auto-derived from sessionid
  "cookies": [                          // optional — explicit cookie array
    { "name": "sessionid", "value": "...", "domain": "instagram.com" }
  ],
  "label": "acct-a"                     // optional human label
}
```

> Duplicates (same `sessionid`) are silently skipped.

**Bulk example**
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

`PUT /admin/sessions/:id` — partial update (send only what changes):

```jsonc
{
  "label": "renamed",              // "" to clear
  "sessionid": "999%3ANEW%3A1"    // re-encrypts secret + refreshes ds_user_id
  // "cookies": [ ... ]           // alternative: supply a cookie array
}
```

Omit credential fields to edit only the label. A bare string body is treated as the new sessionid.

---

## 5. Proxies

Used by `POST /api/proxies` and `POST /admin/proxies`. Same four container shapes as sessions (`array` / `{ proxies: [...] }` / single / `{ raw|text }`).

### Item formats

**Strings**
```
1.2.3.4:8080                      ip:port
1.2.3.4:8080:user:pass            ip:port:user:pass
user:pass@1.2.3.4:8080            user:pass@ip:port
http://user:pass@1.2.3.4:8080     http/https prefix stripped
```

**Standard object**
```jsonc
{
  "host": "1.2.3.4",         // or "proxyIp" | "ip" | "url"
  "port": "8080",            // or "proxyPort"
  "username": "user",        // optional (also: "proxyUsername")
  "password": "pass",        // optional (also: "proxyPassword")
  "label": "residential-us"  // optional
}
```

**Bright Data / Luminati object** — username built as `<customer>-zone-<zone>[-country-<country>][-session-<session>]`
```jsonc
{
  "url": "zproxy.lum-superproxy.io",
  "port": 22225,
  "customer": "lum-customer-c_e11f9742",
  "zone": "residntzone",
  "country": "us",       // optional
  "session": "abc123",   // optional (sticky IP)
  "password": "n0oioikax2i2",
  "label": "lum-residential"
}
```

> `host` and `port` are required per item; duplicates (same `host:port:username`) are skipped.

### Proxy check

`POST /admin/proxies/:id/check` — tests the proxy:
```jsonc
{ "ok": true, "ms": 312, "ip": "1.2.3.4" }
// or
{ "ok": false, "error": "connection refused" }
```

### Proxy update

`PUT /admin/proxies/:id` — partial update:
```jsonc
{
  "label": "px2",         // "" to clear
  "host": "5.6.7.8",      // if present, re-encrypts credentials
  "port": "9090",
  "username": "newuser",
  "password": "newpass"
}
```

Omit `host` to edit only the label. A proxy string (`"5.6.7.8:9090:u:p"`) is also accepted as the whole body.

---

## 6. User Feed — `/api/user-feed`

Fetches an Instagram user's posts + stories via the **private mobile API** using a session from the pool (or inline credentials). Returns data in the `web_profile_info` shape.

### Request

```text
GET /api/user-feed?userId=nasa
GET /api/user-feed/nasa
POST /api/user-feed
```

```jsonc
{
  "userId": "nasa",                  // REQUIRED — username OR numeric user id

  // Auth (pick one, or omit to use the pool)
  "authToken": "<sessionid>",        // also: "sessionid" | "token"
  "csrfToken": "...",                // optional, pairs with authToken
  "proxy": "1.2.3.4:8080:u:p",      // optional; string or proxy object

  // Legacy full account (overrides the above)
  "dominatorAccount": {
    "cookies": [{ "name": "sessionid", "value": "...", "domain": "instagram.com" }],
    "accountBaseModel": {
      "accountProxy": {
        "proxyIp": "1.2.3.4", "proxyPort": "8080",
        "proxyUsername": "u", "proxyPassword": "p"
      }
    }
  },

  "maxId": null,                     // pagination cursor

  // Stories & highlights
  "includeStories": true,            // default true
  "includeHighlightDetails": true,   // default true
  "highlightDetailLimit": 0,         // 0 = expand all bubbles

  // Passthrough (POST only)
  "minTimestamp": null,
  "isNewBrowser": false
}
```

> Auth resolution order: `dominatorAccount` → inline `authToken`/`proxy` → pool (round-robin). No session → `400`.

### Response

`/api/user-feed` returns the result object directly (`200` with posts, `502` when empty).
`/admin/user-feed` wraps it: `{ success, ok, userId, username, count, storyCount, highlightCount, result }`.

```jsonc
{
  "data": {
    "user": {
      "id": "28527810",
      "username": "nasa",
      "full_name": "NASA",
      "is_private": false,
      "is_verified": true,
      "profile_pic_url": "https://…",
      "profile_pic_url_hd": "https://…",
      "edge_followed_by": { "count": 104258106 },
      "edge_follow": { "count": 92 },
      "biography": "…",
      "external_url": "https://www.nasa.gov",
      "edge_owner_to_timeline_media": {
        "count": 4863,
        "page_info": { "has_next_page": true, "end_cursor": "QVFE…" },
        "edges": [
          {
            "node": {
              "__typename": "GraphImage",       // GraphImage | GraphVideo | GraphSidecar
              "id": "3940000000000000000",
              "shortcode": "DbbY9pdm6Q2",
              "dimensions": { "height": 1080, "width": 1080 },
              "display_url": "https://…",
              "thumbnail_src": "https://…",
              "thumbnail_resources": [
                { "src": "…", "config_width": 150, "config_height": 150 }
              ],
              "is_video": false,
              "video_url": null,                // populated on GraphVideo
              "video_view_count": null,
              "dash_info": null,                // populated on GraphVideo
              "edge_media_to_caption": { "edges": [{ "node": { "text": "…" } }] },
              "edge_liked_by": { "count": 51872 },
              "edge_media_preview_like": { "count": 51872 },
              "edge_media_to_comment": { "count": 179 },
              "edge_media_to_tagged_user": { "edges": [] },
              "location": null,
              "taken_at_timestamp": 1785520896,
              "owner": { "id": "28527810", "username": "nasa" },
              "accessibility_caption": null,
              "comments_disabled": false
            }
          }
        ]
      }
    }
  },
  "status": "ok",

  "stories": {
    "available": true,
    "count": 2,
    "source": "anonstories",   // "storynavigation" | "anonstories" | "browser" | null
    "error": null,
    "items": [
      {
        "username": "nasa",
        "type": "video",            // "video" | "image"
        "storyUrl": "https://…",    // image / thumbnail URL
        "videoUrl": "https://…",    // null for photos
        "isVideo": true,
        "createdAt": "30-07-2026 12:15:16 AM",
        "storyDate": "30-07-2026 12:15:16 AM"
      }
    ]
  },

  "highlights": {
    "available": true,
    "count": 6,
    "source": "storynavigation",
    "error": null,
    "items": [
      {
        "id": "18142207969557132",
        "title": "creatives",
        "coverUrl": "https://…",
        "username": "nasa",
        "itemCount": 39            // null when bubble not expanded
      }
    ]
  },

  // Only present when includeHighlightDetails is true (default)
  "highlight_details": {
    "available": true,
    "count": 6,
    "truncated": false,            // true when highlightDetailLimit was applied
    "error": null,
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
            "type": "image",       // "image" | "video"
            "isVideo": false,
            "created": "07-06-2026 07:56:27 PM"
          }
        ]
      }
    }
  }
}
```

> **Quick lookup:** `feed.highlight_details.items[feed.highlights.items[0].id].items` → media array for the first bubble.

---

## 7. Stories & Highlights — `/api/instagram`

Uses third-party story viewers (storynavigation.com, anonstories.com). **No Instagram session or proxy required.**

### Search / Stories request

```text
GET /api/instagram/search?username=nasa
GET /api/instagram/search/nasa
GET /api/instagram/stories/nasa
POST /api/instagram/search
```

```jsonc
{
  "username": "nasa",              // REQUIRED — handle, @handle, or profile URL
  "includeHighlightDetails": true, // default true — expands all bubbles
  "highlightDetailLimit": 0        // 0 = all; positive n = first n bubbles only
}
```

### Search response

```jsonc
{
  "success": true,
  "status": "ok",
  "source": "storynavigation",      // stories source
  "highlightSource": "anonstories", // highlight list source (resolved independently)
  "storiesError": null,
  "highlightsError": null,
  "data": {
    "username": "nasa",
    "fullName": "NASA",
    "profilePic": "https://…",
    "isPrivate": false,
    "isVerified": true,
    "followers": 104258106,
    "following": 92,
    "postCount": 4863,
    "stories": [
      {
        "username": "nasa",
        "type": "video",
        "storyUrl": "https://…",
        "videoUrl": "https://…",
        "isVideo": true,
        "createdAt": "30-07-2026 12:15:16 AM",
        "storyDate": "30-07-2026 12:15:16 AM"
      }
    ],
    "highlights": [
      { "id": "18142207969557132", "title": "creatives", "coverUrl": "https://…", "username": "nasa", "itemCount": 39 }
    ]
  },
  "highlight_details": {
    "18142207969557132": {
      "id": "18142207969557132",
      "title": "creatives",
      "coverUrl": "https://…",
      "source": "storynavigation",
      "count": 39,
      "error": null,
      "items": [
        { "mediaUrl": "https://…", "videoUrl": null, "type": "image", "isVideo": false, "created": "…" }
      ]
    }
  }
}
```

### Single highlight

```text
GET /api/instagram/highlights/:highlightId?username=nasa&userId=28527810
```

Response: `{ success, source, title, count, data[] }` — `data` is the same media items array.
`userId` is only needed as a fallback for the anonstories source.

### Media proxy

```text
GET /api/instagram/media?url=<cdn-url>&inline=1&filename=photo.jpg
```

Proxies one file from an allow-listed CDN. `inline=1` serves it for browser preview; `filename=` sets the download name. Non-CDN hosts are rejected with `403`.

---

## 8. Zip Download — `/api/instagram/download/zip`

Archives multiple stories / highlights to a single `.zip` file.

### Streaming (synchronous)

```jsonc
POST /api/instagram/download/zip
{
  "username": "nasa",
  "items": [
    {
      "url": "https://…",             // REQUIRED — CDN URL
      "type": "video",                // optional — picks file extension
      "kind": "highlight",            // "story" (default) | "highlight" | "profile"
      "highlightId": "18142207969557132",   // optional
      "highlightTitle": "creatives",        // optional — names the subfolder
      "filename": "override.jpg"            // optional — overrides generated path
    }
  ]
}
```

Streams the `.zip` directly in the response body.

### Async (SSE progress)

```text
POST /api/instagram/download/zip/start   → { "jobId": "<uuid>" }
GET  /api/instagram/download/zip/:jobId/events   (SSE: progress events)
GET  /api/instagram/download/zip/:jobId/file     (download the archive)
```

### Zip entry layout

| Kind | Path inside zip |
|---|---|
| `profile` | `nasa.jpg` |
| `story` | `Stories/nasa_Story_1.mp4` |
| `highlight` | `Highlights/Creatives/nasa_Creatives_1.jpg` |

Items that could not be fetched (expired CDN links) are listed in `_failed.txt` inside the archive. Maximum `STORY_MAX_ZIP_ITEMS` items (default 300).

---

## 9. Auth Token — `/api/auth-token`

Manages the stored CSRF token used by the private API.

```jsonc
POST /api/auth-token
{
  "dominatorAccount": { ... }   // optional — same shape as in feed payload
}
```

Response: `{ "success": true, "csrfToken": "…" }`

```text
GET /api/auth-token   → { "csrfToken": "…" }  (or 404 if none stored)
```

---

## 10. Anonyig — `/api/anonyig`

Fetches public Instagram data from the **anonyig worker hub** over a signed HTTP/2 transport. **No Instagram session or proxy needed**; no data from Instagram's own servers.

> A signed chunk file from `anonyig.com` is required. Run `npm run anonyig:chunk` to refresh and mirror it to B2.

### Handle resolution

The handle is read from path, query string, or body — all equivalent:

```text
GET  /api/anonyig/user/nasa
GET  /api/anonyig/user?username=@nasa
POST /api/anonyig/user   { "username": "nasa" }
```

### User details

`GET /api/anonyig/user/:username`

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
    "profilePic": "https://scontent-…cdninstagram.com/…",
    "profilePicProxied": "https://media.anonyig.com/get?…"
  }
}
```

### Tab endpoints

| Endpoint | Parameters | Response shape |
|---|---|---|
| `GET /api/anonyig/posts/:username` | `?pages=1` | `{ success, source, count, pages, pageInfo, data[] }` |
| `GET /api/anonyig/reels/:username` | `?pages=1` | same, filtered to video entries |
| `GET /api/anonyig/stories/:username` | — | `{ success, source, count, data[] }` |
| `GET /api/anonyig/highlights/:username` | `?withItems=true` | `{ success, source, count, data[] }` |

`pages` follows `end_cursor` pagination (~12 posts per page, capped at `ANONYIG_MAX_PAGES`).
`withItems=false` returns covers/titles only (one call). `withItems=true` expands each bubble (one call per bubble).

**Post / reel entry fields:** `id`, `shortcode`, `url`, `type`, `isVideo`, `caption`, `takenAt` (ms), `likeCount`, `commentCount`, `viewCount`, `dimensions`, `carouselIndex`, `carouselCount`, `imageUrl`, `videoUrl`, `imageUrlProxied`, `videoUrlProxied`, `imageUrlDownload`, `videoUrlDownload`.

### Consolidated feed (converted format)

`GET /api/anonyig/feed/:username` — single call for posts + stories + highlights + highlight details, returned in the `web_profile_info` envelope:

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
      "edges": [ { "node": { "__typename": "GraphVideo", "shortcode": "…" } } ]
    }
  } },
  "status": "ok",
  "source": "anonyig",
  "errors": null,
  "stories":          { "available": true, "count": 4, "source": "anonyig", "error": null, "items": [ { "username", "type", "storyUrl", "videoUrl", "createdAt", "storyDate", "isVideo" } ] },
  "highlights":       { "available": true, "count": 4, "source": "anonyig", "error": null, "items": [ { "id", "title", "coverUrl", "username", "itemCount" } ] },
  "highlight_details": { "available": true, "count": 4, "truncated": false, "error": null,
                         "items": { "<highlightId>": { "id", "title", "coverUrl", "username", "source", "count", "error", "items": [ { "mediaUrl", "videoUrl", "type", "isVideo", "created" } ] } } }
}
```

**Parameters:**

| Parameter | Default | Notes |
|---|---|---|
| `pages` | `1` | Post pages; capped by `ANONYIG_MAX_PAGES` |
| `includeHighlightDetails` | `true` | `false` → bubbles only, no `highlight_details` node |
| `highlightDetailLimit` | `0` | `0` = expand all; positive n = first n only |

### Module-native profile shape

`GET /api/anonyig/profile/:username?pages=1&withHighlightItems=true`

```jsonc
{
  "success": true,
  "source": "anonyig",
  "errors": null,
  "fetchedAt": "2026-07-31T09:12:04.771Z",
  "data": {
    "user":       { /* user details as above */ },
    "posts":      { "items": [], "count": 4863, "pages": 1, "pageInfo": { "has_next_page": true, "end_cursor": "…" } },
    "reels":      { "items": [], "count": 6, "pageInfo": {} },
    "stories":    { "items": [], "count": 4 },
    "highlights": { "items": [], "count": 4 }
  }
}
```

### Handle autocomplete

`GET /api/anonyig/suggestions?query=nas`

```jsonc
{ "success": true, "source": "anonyig", "count": 5, "data": [ { "username": "nasa", "fullName": "NASA", "profilePic": "…" } ] }
```

### Diagnostics

`GET /api/anonyig/status` — reports reachability of `anonyig.com` (chunk) and `api-wh.anonyig.com` (data):

| Symptom | Cause | Fix |
|---|---|---|
| `503 no usable anonyig signing chunk` | `anonyig.com` returns `451` for restricted jurisdictions | Run `npm run anonyig:chunk` from an unrestricted machine — it mirrors the chunk to B2 |
| `502 CAPTCHA_REQUIRED` | Datacenter IP distrusted by hub | Set `ANONYIG_PROXY` or `ANONYIG_USE_POOL_PROXY=true` |
| `502 proxy … refused CONNECT` | Proxy unreachable or bad credentials | Check proxy config |

### Errors

`400` bad handle · `404` no such account · `429` hub rate-limiting · `504` timeout · `502` other upstream failure · `503` no signing chunk

---

## 11. FastDL — `/api/fastdl`

Uses **fastdl.app** over a signed HTTP/2 transport. **No Instagram session or proxy needed.**

A signed chunk file from `fastdl.app` is required. Run `npm run fastdl:chunk` to refresh and mirror it to B2.

### Three modes (auto-detected from input)

| Input | Mode | Description |
|---|---|---|
| Instagram post/reel/story URL | **Media details** | Direct CDN download links + metadata |
| Handle (`nasa`, `@nasa`, or `https://instagram.com/nasa/`) | **Profile feed** | Posts + stories + highlights in converted format |
| Numeric highlight ID (15–25 digits or `highlight:<id>`) | **Highlight stories** | Media items inside one bubble |

### Input parameters

The target is read from any of these keys: `url`, `sf_url`, `link`, `username`, `instaUsername`, `handle`, or `highlightId`.

```text
GET  /api/fastdl?url=https://www.instagram.com/p/DbbY9pdm6Q2/
GET  /api/fastdl/nasa?highlightDetailLimit=1
POST /api/fastdl   { "handle": "nasa" }
GET  /api/fastdl/highlights/18142207969557132
```

### Response: Media details (URL input)

```jsonc
{
  "success": true,
  "source": "fastdl",
  "data": [
    {
      "url": [
        { "url": "https://scontent-…cdninstagram.com/…", "name": "MP4", "type": "video", "ext": "mp4" }
      ],
      "meta": {
        "title": "Post caption…",
        "source": "https://www.instagram.com/api/v1/users/web_profile_info/?username=nasa",
        "shortcode": "DbbY9pdm6Q2",
        "comment_count": 179,
        "like_count": 51872,
        "taken_at": 1785520896,
        "username": "nasa"
      },
      "thumb": "https://media.fastdl.app/get?__sig=…",
      "sd": { "url": "https://scontent-…" }
    }
  ]
}
```

### Response: Profile feed (handle input)

Returns the **same `web_profile_info` envelope** as `/api/user-feed` and `/api/anonyig/feed` — existing consumers read it unchanged:

```jsonc
{
  "data": { "user": { /* …same shape as Section 6… */ } },
  "status": "ok",
  "source": "fastdl",
  "errors": null,
  "stories":           { "available": true, "count": 4, "source": "fastdl", "error": null, "items": [ { "username", "type", "storyUrl", "videoUrl", "createdAt", "storyDate", "isVideo" } ] },
  "highlights":        { "available": true, "count": 4, "source": "fastdl", "error": null, "items": [ { "id", "title", "coverUrl", "username", "itemCount" } ] },
  "highlight_details": { "available": true, "count": 4, "truncated": false, "error": null,
                         "items": { "<highlightId>": { "id", "title", "coverUrl", "username", "source", "count", "error", "items": [ { "mediaUrl", "videoUrl", "type", "isVideo", "created" } ] } } }
}
```

**Profile feed parameters:**

| Parameter | Default | Notes |
|---|---|---|
| `pages` | `1` | Post pages; capped by `FASTDL_MAX_PAGES` |
| `includeHighlightDetails` | `true` | `false` → bubbles only |
| `highlightDetailLimit` | `0` | `0` = all; positive n = first n |

### Response: Highlight details (highlight ID input)

`GET /api/fastdl/highlights/:highlightId`

```jsonc
{
  "success": true,
  "source": "fastdl",
  "data": [
    { "mediaUrl": "https://…", "videoUrl": null, "type": "image", "isVideo": false, "created": "07-06-2026 07:56:27 PM" }
  ]
}
```

### Diagnostics

`GET /api/fastdl/status` — reports reachability of `fastdl.app` (chunk) and the worker hub, plus B2 mirror state and whether the chunk currently signs requests.

---

## 12. GraphQL Timeline — `/api/graphql`

Fetches Instagram timeline posts via the **official Instagram GraphQL API** (`doc_id=7950326061742207`) — the same query the web app issues in the browser. Nodes carry the raw `web_profile_info` edge shape verbatim.

> **Requires a valid session in the pool.** Unauthenticated requests return empty edges.

### How it works

1. **Resolve user ID** — calls `web_profile_info?username=<handle>` (public, no session needed) → gets the numeric user ID
2. **Run the GraphQL query** — `GET /graphql/query/?doc_id=7950326061742207&variables={"id":"…","first":12}` using the pool session
3. **Return** — wraps raw nodes in a standard envelope

### Request

```text
GET  /api/graphql/nasa
GET  /api/graphql?username=nasa&first=12
GET  /api/graphql/nasa?first=12&after=QVFE…   (paginate)
POST /api/graphql   { "username": "nasa", "first": 24 }
```

### Parameters

| Parameter | Source | Default | Notes |
|---|---|---|---|
| `username` | path / query / body | — | **Required.** Handle (with or without `@`) |
| `first` | query / body | `12` | Posts per page, max 50 |
| `after` / `endCursor` | query / body | — | Pagination cursor from prior `endCursor` |

### Response

```jsonc
{
  "success": true,
  "source": "graphql",
  "userId": "28527810",
  "username": "nasa",
  "count": 12,                    // posts returned in this page
  "totalCount": 4863,             // total posts on account
  "hasNextPage": true,
  "endCursor": "QVFE…",           // pass as `after` for the next page
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
              "__typename": "GraphImage",        // GraphImage | GraphVideo | GraphSidecar
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
              "video_url": null,               // populated for GraphVideo
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

### Errors

| Code | Reason |
|---|---|
| `400` | Missing `username` |
| `404` | Username could not be resolved to a numeric user ID |
| `502` | Instagram GraphQL upstream failure (session expired, rate-limited, private account) |
| `503` / `401` | No usable pool session |

---

## 13. Shared Response Shapes

### `web_profile_info` user node

All feed/profile endpoints return the user inside `data.user`. Common fields:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Numeric user ID |
| `username` | string | Handle |
| `full_name` | string | Display name |
| `biography` | string | Bio text |
| `is_private` | boolean | |
| `is_verified` | boolean | |
| `profile_pic_url` | string | Standard-res CDN URL |
| `profile_pic_url_hd` | string | HD CDN URL |
| `edge_followed_by.count` | number | Follower count |
| `edge_follow.count` | number | Following count |
| `edge_owner_to_timeline_media.count` | number | Total post count |
| `edge_owner_to_timeline_media.page_info` | object | `{ has_next_page, end_cursor }` |
| `edge_owner_to_timeline_media.edges` | array | Post nodes |

### Post node (`__typename`: `GraphImage` / `GraphVideo` / `GraphSidecar`)

| Field | Type | Notes |
|---|---|---|
| `__typename` | string | Media type |
| `id` | string | Media pk |
| `shortcode` | string | Used in `instagram.com/p/<shortcode>/` |
| `dimensions` | `{ height, width }` | |
| `display_url` | string | Display image CDN URL |
| `thumbnail_src` | string | ~640px thumbnail |
| `thumbnail_resources` | array | Multi-res thumbnail ladder |
| `is_video` | boolean | |
| `video_url` | string\|null | Direct video CDN URL (video only) |
| `video_view_count` | number\|null | View count (video only) |
| `dash_info` | object\|null | DASH manifest info (video only) |
| `edge_media_to_caption.edges[0].node.text` | string | Caption |
| `edge_liked_by.count` | number | Like count |
| `edge_media_to_comment.count` | number | Comment count |
| `taken_at_timestamp` | number | Unix timestamp |
| `owner.id` | string | Owner user ID |
| `owner.username` | string | Owner handle |
| `location` | object\|null | |
| `edge_sidecar_to_children` | object\|null | Carousel children (GraphSidecar only) |

### Story item

| Field | Type | Notes |
|---|---|---|
| `username` | string | |
| `type` | `"video"` \| `"image"` | |
| `storyUrl` | string | Image / thumbnail URL |
| `videoUrl` | string\|null | Video URL (null for photos) |
| `isVideo` | boolean | |
| `createdAt` | string | `"DD-MM-YYYY HH:MM:SS AM/PM"` |
| `storyDate` | string | Same as `createdAt` |

### Highlight bubble

| Field | Type | Notes |
|---|---|---|
| `id` | string | Numeric highlight ID |
| `title` | string | Bubble label |
| `coverUrl` | string | Cover image CDN URL |
| `username` | string | Account handle |
| `itemCount` | number\|null | `null` when bubble was not expanded |

### Highlight detail item

| Field | Type | Notes |
|---|---|---|
| `mediaUrl` | string | Image or video thumbnail URL |
| `videoUrl` | string\|null | |
| `type` | `"image"` \| `"video"` | |
| `isVideo` | boolean | |
| `created` | string | `"DD-MM-YYYY HH:MM:SS AM/PM"` |

---

## 14. Error Reference

All error responses follow the shape `{ "success": false, "error": "<message>" }`.

| HTTP | When |
|---|---|
| `400` | Missing required parameter or malformed input |
| `401` | Admin token expired or missing (admin routes) |
| `403` | Media proxy: host not allow-listed |
| `404` | Account not found, or resource not available |
| `429` | Upstream rate-limit (anonyig / fastdl / Instagram) |
| `500` | Unhandled server error |
| `502` | Upstream returned an error or non-2xx status |
| `503` | No signing chunk available for anonyig or fastdl |
| `504` | Upstream request timed out |

---

## 15. Environment Variables

### Pool & auth

| Variable | Default | Description |
|---|---|---|
| `PASSCODE` | — | Admin dashboard passcode |
| `POOL_ENCRYPT_KEY` | — | AES key for encrypting session/proxy secrets |
| `HTTP_TIMEOUT_MS` | `15000` | Per-request timeout for outgoing IG calls |

### User feed

| Variable | Default | Description |
|---|---|---|
| `FEED_INCLUDE_STORIES` | `true` | Include stories/highlights in feed response |
| `FEED_INCLUDE_HIGHLIGHT_DETAILS` | `true` | Expand highlight bubbles by default |
| `FEED_HIGHLIGHT_DETAIL_LIMIT` | `0` | Max bubbles to expand (0 = all) |
| `FEED_HIGHLIGHT_DETAIL_CONCURRENCY` | `5` | Parallel highlight fetches |
| `FEED_MAX_POSTS` | `100` | Max posts across all pages |
| `FEED_PAGE_COUNT` | `12` | Posts per page |
| `FEED_PAGE_DELAY_MS` | `3000` | Delay between pages |

### Stories (instagram module)

| Variable | Default | Description |
|---|---|---|
| `STORY_ANON_MIN_INTERVAL_MS` | `900` | Min ms between anonstories requests (throttle guard) |
| `STORY_ANON_CACHE_TTL_MS` | `60000` | Cache TTL for anonstories responses |
| `STORY_RETRY_DELAY_MS` | `3000` | Backoff after a 429 from anonstories |
| `STORY_MAX_ZIP_ITEMS` | `300` | Max items in a zip download |

### Anonyig module

| Variable | Default | Description |
|---|---|---|
| `ANONYIG_PROXY` | — | `host:port:user:pass` proxy for anonyig upstream |
| `ANONYIG_USE_POOL_PROXY` | `false` | Use a random pool proxy for anonyig |
| `ANONYIG_TIMEOUT_MS` | `15000` | Upstream request timeout |
| `ANONYIG_MAX_PAGES` | `10` | Max post pages per call |
| `ANONYIG_USER_CACHE_TTL_MS` | `60000` | Cache TTL for user detail responses |

### FastDL module

| Variable | Default | Description |
|---|---|---|
| `FASTDL_PROXY` | — | `host:port:user:pass` proxy for fastdl upstream |
| `FASTDL_USE_POOL_PROXY` | `false` | Use a random pool proxy for fastdl |
| `FASTDL_TIMEOUT_MS` | (falls back to `ANONYIG_TIMEOUT_MS`) | Request timeout |

### B2 / Chunk storage

| Variable | Description |
|---|---|
| `B2_KEY_ID` | Backblaze B2 application key ID |
| `B2_APPLICATION_KEY` | Backblaze B2 application key |
| `B2_BUCKET` | Bucket name |
| `B2_ANONYIG_CHUNK_KEY` | Object key for the anonyig signing chunk |
| `B2_FASTDL_CHUNK_KEY` | Object key for the fastdl signing chunk |

---

*Generated from [API.md](API.md) — GetIGFeed project.*
