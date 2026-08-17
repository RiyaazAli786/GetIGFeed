# anonyig module

Instagram profile data for a public handle from the [anonyig](https://anonyig.com)
worker hub — **user details, posts, reels, stories and highlights**, with each
highlight's stories resolved automatically.

Merged in from the standalone `anonyig` client project and kept in this one
folder: routes, controller, service, client library, signer and chunk fetcher.
Nothing outside `src/anonyig/` imports anything but `./routes` (mounted in
[app.js](../app.js)) and `./service` (closed on shutdown in [index.js](../index.js)).

Like `/api/instagram/*`, these endpoints use **no session and no proxy** — the
upstream is a third-party viewer, not Instagram's private API. They are a
separate route group because it is a different upstream with its own transport:
signed HTTP/2 rather than a plain fetch.

## Endpoints

Base path `/api/anonyig`. The handle is read from the path, the query string or
the body, so all three forms below are the same call.

| Method | Path | Returns |
| ------ | ---- | ------- |
| GET/POST | `/user`, `/user/:username` | profile header — id, name, bio, counts, verified, avatar |
| GET | `/posts/:username?pages=` | posts; carousels expand to one entry per child |
| GET | `/reels/:username?pages=` | posts filtered to those with a video URL |
| GET | `/stories/:username` | active stories |
| GET | `/highlights/:username?withItems=` | highlight bubbles **with each album's stories attached** |
| GET/POST | `/feed`, `/feed/:username?pages=` | **everything in one call, in this project's converted JSON** |
| GET/POST | `/profile`, `/profile/:username?pages=` | the same data in the module's own normalized shape |
| GET | `/suggestions?query=` | handle autocomplete |
| GET | `/status` | diagnostics — reachability of both hosts, chunk state (no handle) |

```bash
curl 'http://localhost:3000/api/anonyig/user/nasa'
curl 'http://localhost:3000/api/anonyig/user?username=@nasa'
curl -X POST -H 'content-type: application/json' -d '{"username":"nasa"}' \
     'http://localhost:3000/api/anonyig/user'
```

Every response is `{ success, source: "anonyig", … , data }`. Failures go through
the app's central error handler: `400` invalid or missing handle, `404` no such
account, `504` upstream timeout, `502` anything else upstream (the hub's own
status is never replayed as ours).

`pages` follows `end_cursor` pagination — one page is ~12 posts and one upstream
call, clamped to `ANONYIG_MAX_PAGES`. `withItems=false` on `/highlights` returns
covers and titles only: one call instead of one per highlight.

`/feed` and `/profile` fetch the tabs concurrently over a single h2 session, and
a tab that fails (private account, no stories) is reported in `errors` rather
than failing the request. `reels` costs no extra call — the site has no reels
endpoint, it filters the posts feed it already has.

## `/feed` — the converted format

One call for **posts, stories, highlights and every highlight's stories**,
emitted in the converted JSON the rest of this API returns:

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
      "edges": [ { "node": { "__typename": "GraphVideo", … } } ]
    }
  } },
  "status": "ok",
  "source": "anonyig",
  "errors": null,                    // per-part failures, e.g. { "stories": "…" }
  "stories":     { "available": true, "count": 4, "source": "anonyig", "error": null, "items": [] },
  "highlights":  { "available": true, "count": 4, "source": "anonyig", "error": null, "items": [] },
  "highlight_details": { "available": true, "count": 4, "truncated": false,
                         "error": null, "items": { "<highlightId>": {} } }
}
```

[convertedFeed.js](convertedFeed.js) maps the hub's **raw** payloads (not
`client.js`'s normalizers, which flatten carousels away) into the exact node the
feed's [mapFeedToWebProfile.js](../utils/mapFeedToWebProfile.js) emits — same 30
keys, carousel children under `edge_sidecar_to_children`, the same
`thumbnail_resources` ladder. `stories.items`, `highlights.items` and
`highlight_details.items` match what the story parsers produce for
`/api/instagram/*`, down to the numeric highlight ids. So an existing consumer of
`/api/user-feed` reads this unchanged; only the source differs.

Options: `?pages=` (post pages), `?includeHighlightDetails=false` (bubbles only —
drops the `highlight_details` node and one call per highlight),
`?highlightDetailLimit=n` (expand only the first n; the rest are reported as
`truncated: true`).

Note that the converted nodes carry Instagram's own CDN links. Use `/profile` if
you want anonyig's proxied and downloadable variants of every URL as well, which
outlive the hot-link-protected originals.

## Using the client directly

```js
const { AnonyIG } = require('./src/anonyig/client');

const ig = new AnonyIG();
try {
  const profile = await ig.getEverything('nasa');
  console.log(profile.highlights.items[0].items.length);   // stories already there
} finally {
  ig.close();
}
```

High level: `getUser` · `getPosts` · `getReels` · `getStories` · `getHighlights`
· `getEverything`. Raw pass-throughs for fields the normalizers drop: `userInfo`,
`profileRaw`, `postsPage`, `postsPageV1`, `storiesRaw`, `storyByUrl`,
`highlightsRaw`, `highlightStoriesRaw`, `usernameSuggestions`, `convert`.

`service.js` is the seam the HTTP layer uses — it owns the single shared client,
validates handles, clamps `pages` and maps upstream failures to HTTP statuses.

## How signing works

Every request body carries five extra fields:

| Field | Meaning |
| ----- | ------- |
| `ts` | `Date.now()` minus the measured server clock offset |
| `_ts` | constant baked into the site's chunk at build time |
| `_tsc` | clock offset vs. the server, zeroed when under 60 s |
| `_sv` | scheme version (`2`) |
| `_s` | `HMAC-SHA256(secret, message)`, hex |

```
message = (typeof body === "string" ? body : JSON.stringify(sortKeys(body))) + ts
```

The HMAC key is decoded inside an obfuscated chunk and zero-filled straight after
`crypto.subtle.importKey`, so it is only reachable through the closure. Rather
than extracting it, [signer.js](signer.js) runs that chunk in a `vm` sandbox with
a minimal browser shim and calls the signer it exports.

Requests **must** go over HTTP/2. The identical signed request over HTTP/1.1 (all
that Node's global `fetch` speaks) is answered `422 CAPTCHA_REQUIRED`; over
`node:http2` it returns `200` with no captcha token at all. That is why this
module does not use `../utils/httpFetch.js`.

## The signing chunk

The chunk is anonyig's own code and carries their signing secret, so it is not
committed. [chunk.js](chunk.js) resolves it from three places, in order:

1. **disk** — `DATA_DIR/anonyig/live_link_chunk.js`, ephemeral on free hosts
2. **B2** — the bucket the pool already uses, key `B2_ANONYIG_CHUNK_KEY`
3. **the site** — `anonyig.com`, whose entry bundle names the current chunk

Only a copy that has just produced a real signature is stored, and one fetched
from the site is mirrored to B2 automatically. Locally that means zero setup: the
first request downloads it.

**Deployed hosts often cannot do (3).** anonyig.com answers **HTTP 451
(Unavailable For Legal Reasons)** to hosts in jurisdictions it refuses — Render's
egress among them — so the download that works on a laptop fails there. That is
what (2) is for. Publish the chunk once from a machine that can reach the site,
with the deployment's B2 credentials in `.env`:

```bash
npm run anonyig:chunk     # refreshes from the site, mirrors to B2, verifies it signs
```

Every instance then reads it from B2 and never touches anonyig.com. The chunk's
`_ts` build constant and cache-busting hash change when the site deploys, so
repeat that command whenever signatures start being rejected — the running
service also refetches by itself when a stored copy stops loading, and retries
once on a `401 REQUEST_SIGNATURE_*` from the hub.

With no chunk available anywhere, requests fail `503` with a message naming what
each source said, rather than a bare 500.

The one thing a mirrored chunk does **not** work around is the worker hub itself
refusing the host — `api-wh.anonyig.com` is a separate host with its own rules.
That is the next section.

## Cloud hosts: the captcha gate

Once signing works, the hub answers **`422 CAPTCHA_REQUIRED`** (a Cloudflare
Turnstile challenge) to addresses it distrusts — and every datacenter range is
distrusted. A laptop gets data; a cloud instance gets the challenge. Nothing
about the request is wrong, so no retry clears it: the traffic has to leave from
an address the hub trusts.

```bash
ANONYIG_PROXY=host:port:user:pass           # or http://user:pass@host:port
ANONYIG_USE_POOL_PROXY=true                 # or draw one from the /admin pool
```

`host:port:user:pass`, `user:pass@host:port` and `http://user:pass@host:port` all
parse (passwords containing `:` or `@` included) — everything `/admin` accepts,
and then some. A bare `host:port` sends no credentials, which a proxy that wants
them answers with `407`; that is the usual cause of a failing tunnel.

A value that cannot be parsed is a hard error rather than a silent fall back to a
direct connection — that would send the traffic from the address the proxy exists
to avoid, and the captcha it earns would look like the proxy failing to help
rather than never being used. Pool mode is the exception: an empty or
undecryptable pool warns and goes direct, since that is a transient state rather
than a typo, and `/status` reports which it was.

[proxy.js](proxy.js) opens the connection by hand — `CONNECT` to the hub, TLS
with **ALPN `h2`**, then `http2.connect` over that socket. It cannot reuse
`https-proxy-agent` the way [webParameter.js](../services/webParameter.js) does,
because that serves Node's http/https stack and the hub requires HTTP/2 (an
HTTP/1.1 request is itself answered with a captcha). A proxy that downgrades the
connection is rejected with a message saying exactly that, rather than
resurfacing later as an unexplained `CAPTCHA_REQUIRED`.

One session is opened per client and reused for every call, so the tunnel cost is
paid once. Proxy failures come back as `502` naming the proxy (never its
credentials): refused `CONNECT`, bad credentials (`407`), TLS failure, or a
non-h2 negotiation.

A *datacenter* proxy usually will not help — it is the address's reputation being
judged, not the fact of proxying. Without any proxy, `ANONYIG_WH_TOKEN` accepts a
`wh-cf-token` copied from a browser session on anonyig.com and works until that
token expires.

## Diagnostics

`GET /api/anonyig/status` — no handle, no side effects:

```jsonc
{
  "verdict": "ok — signing works and the hub is reachable",
  "site":  { "host": "https://anonyig.com",        "reachable": true, "status": 200 },
  "hub":   { "host": "https://api-wh.anonyig.com", "reachable": true, "status": 401,
             "code": "REQUEST_SIGNATURE_MISSING_REQUIRED_PARAMETERS" },
  "chunk": { "local":  { "path": "…", "present": true, "bytes": 114316, "modified": "…" },
             "mirror": { "configured": true, "location": "B2 (…)", "present": true },
             "signer": { "ready": true, "error": null } }
}
```

The two hosts are probed separately because they are blocked independently, and a
failing request cannot tell them apart — the chunk is fetched first, so a refused
site masks whatever the hub would have said. The hub probe is an intentionally
unsigned request: `401 REQUEST_SIGNATURE_MISSING_REQUIRED_PARAMETERS` proves it
answered. `verdict` states which fix applies:

| What you see | What it means |
| ------------ | ------------- |
| site 451, mirror present, signer ready | working — the mirror is doing its job |
| site 451, mirror absent | run `npm run anonyig:chunk` with the deployment's B2 credentials |
| `hub.challenged: true` (422) | this host's address is distrusted — set `ANONYIG_PROXY` or `ANONYIG_USE_POOL_PROXY=true` |
| hub not reachable at all | the host cannot open a connection; a proxy is the only route |

`hub.proxy` names the proxy the probe went through, so a challenge that persists
after configuring one is immediately distinguishable from no proxy being applied.

## Configuration

All optional — see [.env.example](../../.env.example).

| Variable | Default | |
| -------- | ------- | - |
| `ANONYIG_TIMEOUT_MS` | `20000` | per-request timeout |
| `ANONYIG_CONCURRENCY` | `4` | parallel requests in the highlight fan-out |
| `ANONYIG_USER_CACHE_TTL_MS` | `300000` | profile-header cache (`0` disables) |
| `ANONYIG_DEFAULT_PAGES` | `1` | pages when the caller does not say |
| `ANONYIG_MAX_PAGES` | `10` | ceiling on `?pages=` |
| `ANONYIG_CHUNK_PATH` | `$DATA_DIR/anonyig/live_link_chunk.js` | where the chunk is stored locally |
| `B2_ANONYIG_CHUNK_KEY` | `anonyig/live_link_chunk.js` | key for the B2 mirror (uses the pool's `B2_*` credentials) |
| `ANONYIG_WORKER_HUB` | `https://api-wh.anonyig.com` | API origin |
| `ANONYIG_PROXY` | — | tunnel the hub through this proxy (needed on cloud hosts) |
| `ANONYIG_USE_POOL_PROXY` | `false` | instead draw a proxy from the `/admin` pool |
| `ANONYIG_WH_TOKEN` / `ANONYIG_X_TOKEN` | — | passthrough headers; `wh-cf-token` is the captcha token |

## Notes

This talks to a third-party service with its own terms and rate limits, and only
reaches data that service already exposes publicly. There is no login and no
private content. Keep request volume sane — `/profile` makes a handful of calls
per handle, one of them per highlight.
