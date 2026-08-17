# GetIGFeed

A small Node.js / Express service that fetches the **most recent 12 posts** of an
Instagram user feed and returns them in the `web_profile_info` GraphQL shape,
**together with the account's active stories and highlights** in the same
response.

It manages a pool of Instagram **sessions** and **proxies** (stored **encrypted**
at rest), attaches the right cookies / `Authorization` header / proxy per request,
and logs every converted response to disk. Ported from the C#
`GetUserFeedAsync` / `GetWebParameter` implementation, with the stories &
highlights half ported from `InstagramStoryViewModel.SearchUserIDExecute`
(previously the separate GetInstaStoryHighlight service, now merged in).

## Features

- **`POST /api/user-feed`** — fetch the first page (12 recent posts), returned in
  `web_profile_info` format (`data.user.edge_owner_to_timeline_media.edges[]`).
- **Stories & highlights merged into the feed** — the same call returns
  `stories`, `highlights` and `highlight_details` nodes alongside `data`. These
  come from third-party story viewers, so they need **no session and no proxy**,
  and a failure there never fails the feed.
- **Standalone story endpoints** — `/api/instagram/search`,
  `/api/instagram/highlights/:id`, plus a media proxy and zip downloader.
- **Encrypted pool** of sessions + proxies (AES-256-GCM) with bulk add / list /
  delete endpoints. Secrets are decrypted only at the moment of use.
- **Flexible auth** — pass just an `authToken` (+ optional `proxy`) per request,
  or rely on the stored pool (round-robin). No full account object required.
- **Proxy formats** — `ip:port`, `ip:port:user:pass`, `user:pass@ip:port`,
  `http://…`, and **Luminati / Bright Data** objects (username built from
  `customer` + `zone`).
- **Bearer authorization** — builds `Bearer IGT:2:base64({ds_user_id, sessionid})`
  from the session automatically.
- **Direct connection** when no proxy is configured.
- **Admin dashboard** at `/admin` — passcode-gated pool CRUD, plus **Fetch Feed**
  and **Stories & Highlights** tabs that preview media and download it (single
  file or a progress-tracked zip).
- **Request debugging** via `DEBUG_HTTP=1`.

## Quick start

```bash
npm install
cp .env.example .env      # then set ENCRYPTION_KEY
npm run dev               # nodemon, or: npm start
```

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Fetch a feed (auth token + proxy inline):

```bash
curl -X POST http://localhost:3000/api/user-feed \
  -H "Content-Type: application/json" \
  -d '{ "userId":"44725523631", "authToken":"YOUR_SESSIONID", "proxy":"1.2.3.4:8080:user:pass" }'
```

See **[Run.md](Run.md)** for full setup, every endpoint, Luminati proxy usage,
debugging, and troubleshooting.

## Endpoints

| Method | Path                                   | Purpose                                            |
| ------ | -------------------------------------- | -------------------------------------------------- |
| GET    | `/health`                              | health check                                       |
| POST   | `/api/user-feed`                       | 12 recent posts + stories/highlights nodes         |
| POST   | `/api/sessions`                        | bulk add sessions (encrypted)                      |
| GET    | `/api/sessions`                        | list sessions (masked)                             |
| DELETE | `/api/sessions/:id`                    | delete one session / all                           |
| POST   | `/api/proxies`                         | bulk add proxies (creds encrypted)                 |
| GET    | `/api/proxies`                         | list proxies (no creds)                            |
| DELETE | `/api/proxies/:id`                     | delete one proxy / all                             |
| POST   | `/api/auth-token`                      | fetch + rotate csrf token                          |
| GET    | `/api/auth-token`                      | read stored csrf token                             |
| POST   | `/api/instagram/search`                | stories + highlights for a handle (no session)     |
| GET    | `/api/instagram/stories/:username`     | same lookup, GET form                              |
| GET    | `/api/instagram/highlights/:id`        | media inside one highlight bubble                  |
| GET    | `/api/instagram/media?url=`            | media proxy / download (allow-listed CDNs only)    |
| POST   | `/api/instagram/download/zip`          | zip a list of media items                          |
| POST   | `/api/instagram/download/zip/start`    | start a zip job (SSE progress + file download)     |
| GET    | `/api/anonyig/user/:username`          | user details from the anonyig hub (no session)     |
| GET    | `/api/anonyig/posts/:username`         | posts (`?pages=`); `/reels/:username` for reels    |
| GET    | `/api/anonyig/stories/:username`       | active stories                                     |
| GET    | `/api/anonyig/highlights/:username`    | highlight bubbles with their stories attached      |
| GET    | `/api/anonyig/feed/:username`          | posts + stories + highlights + highlight stories, in the converted feed JSON |
| GET    | `/api/anonyig/profile/:username`       | the same data in the module's normalized shape     |
| GET    | `/admin`                               | dashboard (pool CRUD, feed, stories & highlights)  |

## Project structure

```
src/
├── index.js                        # entry point (HTTP server)
├── app.js                          # express app + route wiring
├── config/
│   ├── constants.js                # base URL, app id, headers, page size
│   └── story.js                    # story-source endpoints + merge defaults
├── controllers/                    # request validation + response shaping
├── routes/                         # /api, /api/instagram and /admin routes
├── services/
│   ├── instagram.service.js        # getUserFeed (first page → web_profile shape)
│   ├── authToken.service.js        # csrf token fetch/rotate
│   ├── webParameter.js             # cookie+proxy agent, headers, debug logging
│   ├── feedStoryMerge.js           # story options + grafting nodes onto the feed
│   ├── instagramStory.service.js   # SearchUserIDExecute / GetHighlightDetails
│   ├── storyFetcher.js             # StoryFetcher port (session cookies, POSTs)
│   ├── browserFallback.js          # optional puppeteer scrape (anonyig.com)
│   └── download.service.js         # media proxy + zip jobs (SSE progress)
├── anonyig/                        # anonyig worker hub — self-contained module
│   ├── routes.js / controller.js   # /api/anonyig/* — user, posts, reels, …
│   ├── service.js                  # shared client, validation, error mapping
│   ├── convertedFeed.js            # /feed — everything in converted feed JSON
│   ├── client.js                   # signed HTTP/2 client + normalizers
│   ├── signer.js / chunk.js        # request signing + the chunk it needs
│   └── README.md                   # endpoints, signing, configuration
├── parsers/                        # story / highlight response handlers
├── store/
│   ├── poolStore.js                # ENCRYPTED sessions + proxies + parsing
│   ├── tokenStore.js               # csrf token store
│   └── feedLog.js                  # per-call converted-result logs
└── utils/
    ├── crypto.js                   # AES-256-GCM encrypt/decrypt
    ├── mapFeedToWebProfile.js      # feed/user items → web_profile_info shape
    ├── httpFetch.js                # fetch + timeout for the story sources
    ├── json.js / strings.js        # JsonHandler / GetBetween ports
    └── helpers.js                  # sleep(), mobile auth, mapWithConcurrency
```

## Security

- `.env` and `data/` are git-ignored — **never commit** your `ENCRYPTION_KEY`,
  sessions, or proxies.
- Session ids and proxy credentials are encrypted at rest; list endpoints never
  return secrets.
- Keep `ENCRYPTION_KEY` stable — changing it makes stored secrets undecryptable.

## License

MIT
