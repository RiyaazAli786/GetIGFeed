# Deploying to Render

This repo ships a [`render.yaml`](render.yaml) Blueprint, so Render can provision
everything from one file.

## 1. Push to GitHub

Render deploys from a Git repo. Push this project to a GitHub (or GitLab) repo.
`.env` and `data/` are git-ignored and will **not** be pushed — that's intended;
secrets are set in Render, not in the repo.

## 2. Create the Blueprint

1. In the [Render dashboard](https://dashboard.render.com) → **New +** → **Blueprint**.
2. Connect the repo. Render detects `render.yaml` and shows the `getuserfeed` service.
3. You'll be prompted for **`ADMIN_PASSCODE`** (marked `sync: false`) — enter the
   passcode you'll use to unlock the `/admin` dashboard.
4. Click **Apply**. Render runs `npm ci`, then `npm start`.

Render sets `PORT` automatically; the app already reads `process.env.PORT`.

## 3. Verify

Once live (`https://<your-service>.onrender.com`):

```bash
curl https://<your-service>.onrender.com/health          # {"status":"ok"}

# needs no pool, no proxy and no passcode — good first proof the deploy works
curl https://<your-service>.onrender.com/api/anonyig/user/nasa
curl https://<your-service>.onrender.com/api/anonyig/feed/nasa
```

The first `/api/anonyig/*` call on a fresh instance takes about a second longer
than the rest: it downloads the signing chunk before it can sign anything.

Then open `https://<your-service>.onrender.com/admin`, enter your passcode, and
manage sessions/proxies. The dashboard auto-locks after 30s of inactivity.

## 4. Publish the anonyig signing chunk

**Do this once, or `/api/anonyig/*` will not work on Render.**

That module signs its requests with a chunk of anonyig's own code, normally
downloaded on first use. Render cannot download it: `anonyig.com` answers
**HTTP 451 (Unavailable For Legal Reasons)** to its egress IPs, and the endpoint
then fails with `503 no usable anonyig signing chunk`.

The fix is to publish the chunk from a machine that *can* reach the site — it is
stored in the same B2 bucket as the pool, and every instance reads it from there:

```bash
# locally, with the deployment's B2_* credentials in .env
npm run anonyig:chunk
# -> Stored …/data/anonyig/live_link_chunk.js
# -> Mirrored to B2 (bucket "igservice", key "anonyig/live_link_chunk.js")
# -> Verified: chunk signs requests
```

Confirm from the deployed service:

```bash
curl https://<your-service>.onrender.com/api/anonyig/status
```

`verdict` says which case you are in — `site` returning 451 is expected and
harmless once `chunk.mirror.present` is `true` and `chunk.signer.ready` is
`true`. If `hub.reachable` is `false`, the worker hub itself is blocked and no
chunk helps; those requests would have to leave through a proxy.

Repeat `npm run anonyig:chunk` if signatures start being rejected — anonyig
rotates the chunk on every deploy of their site.

## 5. Give the anonyig module a proxy

Once signing works, the worker hub is the next gate. It answers
**`422 CAPTCHA_REQUIRED`** — a Cloudflare Turnstile challenge — to addresses it
distrusts, and **every datacenter range is distrusted**, Render's included. The
same request from a home connection is answered normally, which is why this only
appears once deployed.

There is no retry that clears it; the traffic has to leave from an address the
hub trusts. Set **one** of these:

| Variable | Use when |
| -------- | -------- |
| `ANONYIG_PROXY` | you have a residential/mobile proxy. `sync: false`, so enter it in the Render dashboard rather than the repo. |
| `ANONYIG_USE_POOL_PROXY=true` | you already keep proxies in `/admin` — one is drawn per connection, round-robin |

**Include the credentials.** Any of these forms work, in `ANONYIG_PROXY` or in
the `/admin` proxy pool:

```
host:port:user:pass
user:pass@host:port
http://user:pass@host:port
```

A bare `host:port` sends no credentials, and a proxy that wants them answers
`502 proxy <host> refused CONNECT: HTTP 407 — no credentials were sent`. That is
the single most common cause of this error. If your provider authenticates by IP
allow-list instead, add this service's outbound address there — note Render's
free plan does not give you a static one.

Passwords containing `:` or `@` are kept intact in all three forms. The pool's
own parser truncates them, so if a proxy works via `ANONYIG_PROXY` but not via
the pool, re-add it with the credentials percent-encoded.

A value that cannot be parsed is rejected outright rather than quietly falling
back to a direct connection, since that would send the traffic from the very
address the proxy exists to avoid.

A *datacenter* proxy usually will not help: the challenge is about the address's
reputation, not about proxying. The hub also requires HTTP/2, so the connection
is a `CONNECT` tunnel with h2 negotiated over ALPN — a proxy that downgrades to
HTTP/1.1 is rejected with a message saying so rather than failing obscurely.

Check the result:

```bash
curl https://<your-service>.onrender.com/api/anonyig/status
```

`hub.challenged: true` means the address is still distrusted (the response names
the proxy in use, if any). `verdict: "ok — signing works and the hub is
reachable"` means you are done.

As a stopgap without a proxy, `ANONYIG_WH_TOKEN` accepts a `wh-cf-token` copied
from a browser session on anonyig.com — it works until that token expires.

## 6. Data persistence

The encrypted pool is stored in **Backblaze B2** (the `B2_*` vars), so it
survives restarts and redeploys **without a paid disk** — the Blueprint runs on
the **free plan** (no credit card required). csrf tokens, feed logs and the
anonyig signing chunk go to the local filesystem (`DATA_DIR`, default `./data`),
which is ephemeral on free instances; that's fine, they're regenerated on demand
— the chunk re-downloads itself on the first `/api/anonyig/*` call after a cold
start.

- **`ENCRYPTION_KEY`** is generated once by Render (`generateValue: true`) and
  stays stable, so the pool stored in B2 remains decryptable across deploys.
  ⚠️ Do not change it later, or the stored pool becomes unreadable (clear and
  re-add it if you must rotate the key). Note: a pool encrypted locally with a
  different key won't decrypt on Render — just re-add sessions via `/admin`.

### Free plan caveats

Free instances **sleep after ~15 min of inactivity** and cold-start (~30–60s) on
the next request. Fine for admin/low-traffic use. For always-on, no-cold-start
performance, change `plan: free` to `plan: starter` in [`render.yaml`](render.yaml)
— that requires a card on file.

## Environment variables

| Var | Set by | Purpose |
| --- | --- | --- |
| `NODE_ENV` | blueprint | `production` |
| `PORT` | Render | injected automatically |
| `DATA_DIR` | optional | runtime state — csrf token, feed logs, anonyig chunk. Defaults to `./data`; the Blueprint leaves it unset (no disk is mounted, and the pool lives in B2). Set it to a disk mount point if you add one. |
| `ENCRYPTION_KEY` | Render (generated) | AES-256-GCM key for the pool |
| `ADMIN_PASSCODE` | **you, at deploy** | unlocks the `/admin` dashboard |
| `ADMIN_IDLE_MS` | blueprint | dashboard auto-lock window (default `30000`) |
| `FEED_PAGE_COUNT`, `CSRF_MAX_USES` | blueprint | feed tuning |
| `FEED_INCLUDE_STORIES`, `FEED_INCLUDE_HIGHLIGHT_DETAILS` | blueprint | merge stories/highlights into the feed response |
| `FEED_HIGHLIGHT_DETAIL_LIMIT`, `FEED_HIGHLIGHT_DETAIL_CONCURRENCY` | blueprint | cap the per-highlight media lookups |
| `STORY_REQUEST_TIMEOUT_MS` | blueprint | timeout for the story sources |
| `ANONYIG_TIMEOUT_MS`, `ANONYIG_CONCURRENCY` | blueprint | `/api/anonyig/*` request timeout and highlight fan-out |
| `ANONYIG_USER_CACHE_TTL_MS` | blueprint | in-process profile-header cache |
| `ANONYIG_DEFAULT_PAGES`, `ANONYIG_MAX_PAGES` | blueprint | default and maximum `?pages=` |
| `ANONYIG_CHUNK_PATH` | optional | overrides where the signing chunk is stored (defaults under `DATA_DIR`) |
| `B2_ANONYIG_CHUNK_KEY` | blueprint | B2 key the signing chunk is mirrored to — see [step 4](#4-publish-the-anonyig-signing-chunk) |
