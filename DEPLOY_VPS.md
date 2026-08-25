# Deploying to a Docker VPS (app.reelsflow.io)

This is the companion to [DEPLOY.md](DEPLOY.md) (which covers Render) for a
self-managed VPS that already runs Docker. It uses:

- [`Dockerfile`](Dockerfile) — builds the API image (Node 20 Alpine).
- [`docker-compose.yml`](docker-compose.yml) — runs the container, bound to
  `127.0.0.1:3000` only.
- [`deploy/nginx-app.reelsflow.io.conf`](deploy/nginx-app.reelsflow.io.conf) —
  host-nginx reverse proxy + TLS termination for the domain.

DNS for `app.reelsflow.io` already resolves to the VPS, so no DNS step is
needed — start at Step 0.

Run everything below **on the VPS**, over your own SSH session
(`ssh root@200.234.41.82`) — this was prepared without direct access to that
server, so paste these commands into your own terminal.

## Step 0 — check what's already on ports 80/443

The box already runs other Docker workloads, so confirm nothing else is
bound to the ports this deploy needs before proceeding:

```bash
docker ps
sudo ss -tlnp | grep -E ':80|:443|:3000'
```

- **Nothing listening on 80/443** → follow this doc as written (host nginx +
  certbot).
- **A reverse-proxy container is already there** (`nginx-proxy`, Traefik,
  Caddy, etc.) → skip Step 4/5 below and instead attach `getigfeed` to that
  proxy's Docker network and add its label/env-var convention for the host
  `app.reelsflow.io` pointing at container port `3000`. Say which proxy it is
  if you want exact config for it.
- **Port 3000 already used by something else** → change the port mapping in
  `docker-compose.yml` (both sides of `ports:`) and in the nginx conf's
  `proxy_pass`.

## Step 1 — get the code onto the server

```bash
mkdir -p /opt/getigfeed && cd /opt/getigfeed
git clone https://github.com/RiyaazAli786/GetIGFeed.git .
```

(Re-deploys later: `cd /opt/getigfeed && git pull` then re-run Step 3's build.)

## Step 2 — configure environment

```bash
cp .env.example .env
```

Generate a stable encryption key for the session/proxy pool (do this once —
changing it later makes any already-stored pool unreadable):

```bash
docker run --rm node:20-alpine node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Edit `.env` and set at minimum:

```
NODE_ENV=production
PORT=3000
ENCRYPTION_KEY=<paste the value generated above>
ADMIN_PASSCODE=<pick a passcode to unlock /admin>
```

Everything else in `.env.example` has a working default — see the table at
the bottom of [DEPLOY.md](DEPLOY.md) for what each one does. Two notes that
carry over from Render because this VPS is also a datacenter host:

- `/api/anonyig/*` needs the signing chunk published to B2 once from a
  machine that can reach anonyig.com (skip if you don't use this route) —
  [DEPLOY.md §4](DEPLOY.md#4-publish-the-anonyig-signing-chunk).
- The anonyig/fastdl worker hubs challenge datacenter IPs with a CAPTCHA —
  you'll likely need `ANONYIG_PROXY` / `FASTDL_PROXY` (a residential proxy) —
  [DEPLOY.md §5](DEPLOY.md#5-give-the-anonyig-module-a-proxy). Unlike Render,
  this VPS *can* reach anonyig.com/fastdl.app directly, so the chunk download
  itself isn't blocked — only the worker-hub CAPTCHA gate is.

## Step 3 — build and run the container

```bash
cd /opt/getigfeed
docker compose up -d --build
docker compose logs -f --tail=50   # Ctrl+C once you see "listening on http://localhost:3000"
```

Sanity check locally on the box before wiring up nginx:

```bash
curl -s http://127.0.0.1:3000/health
```

Expect `{"status":"ok"}`.

## Step 4 — install nginx + certbot (skip if Step 0 found a proxy already)

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

## Step 5 — reverse proxy + TLS

```bash
sudo cp deploy/nginx-app.reelsflow.io.conf /etc/nginx/sites-available/app.reelsflow.io
sudo ln -s /etc/nginx/sites-available/app.reelsflow.io /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d app.reelsflow.io
```

Certbot rewrites the config in place to add the 443 server block and sets up
auto-renewal (`certbot renew` via systemd timer/cron — check with
`systemctl list-timers | grep certbot`).

## Step 6 — verify

```bash
curl -s https://app.reelsflow.io/health
curl -s https://app.reelsflow.io/api/anonyig/user/nasa
curl -s https://app.reelsflow.io/api/anonyig/feed/nasa
```

Then open `https://app.reelsflow.io/admin` in a browser, enter the
`ADMIN_PASSCODE` from Step 2, and add sessions/proxies as needed.

## Active URL list

Base URL: **`https://app.reelsflow.io`**

| Endpoint | Notes |
| --- | --- |
| `GET /health` | liveness check, no auth |
| `GET /instagram-view.html` | static viewer page |
| `GET /admin` | passcode-gated dashboard UI |
| `GET/POST /admin/login`, `/admin/logout`, `/admin/status` | dashboard auth |
| `GET/POST/PUT/DELETE /admin/sessions[/:id]` | session pool CRUD (auth) |
| `GET/POST/PUT/DELETE /admin/proxies[/:id]`, `POST /admin/proxies/:id/check` | proxy pool CRUD (auth) |
| `GET /admin/instagram`, `/admin/instagram/check-session` | ad-hoc Instagram probe (auth) |
| `POST/GET /admin/user-feed[/:userId]` | feed lookup via dashboard (auth) |
| `POST/GET /admin/story-highlight[/:username]`, `/admin/highlight-details/:highlightId` | story/highlight lookup (auth) |
| `POST/GET/DELETE /api/sessions[/:id]` | session pool CRUD, unauthenticated API |
| `POST/GET/DELETE /api/proxies[/:id]` | proxy pool CRUD, unauthenticated API |
| `POST/GET /api/auth-token` | Instagram auth token store |
| `POST/GET /api/user-feed[/:userId]` | private-API user feed (needs session/proxy) |
| `GET /api/v1/feed/user/:userId/username` | alias of the above |
| `POST/GET /api/instagram/search[/:username]`, `/stories`, `/story[/:username]` | story lookup by user id/username |
| `GET /api/instagram/highlights/:highlightId` | highlight detail |
| `GET /api/instagram/media` | media proxy/download |
| `POST /api/instagram/download/zip`, `POST /download/zip/start`, `GET /download/zip/:jobId/events`, `GET /download/zip/:jobId/file` | zip export (SSE progress) |
| `GET/POST /api/anonyig/user[/:username]` | anonyig user details |
| `GET /api/anonyig/posts/:username`, `/reels/:username`, `/stories/:username`, `/highlights/:username` | anonyig per-type lookups |
| `GET/POST /api/anonyig/feed[/:username]` | anonyig combined feed |
| `GET/POST /api/anonyig/profile[/:username]` | anonyig profile |
| `GET /api/anonyig/suggestions` | anonyig suggested accounts |
| `GET /api/anonyig/status` | signing-chunk / worker-hub diagnostics |
| `GET/POST /api/fastdl[/:username]`, `GET /api/fastdl/highlights/:highlightId` | fastdl lookups |
| `GET /api/fastdl/status` | fastdl diagnostics |
| `GET/POST /api/graphql[/:username]` | GraphQL timeline media fetch |

Routes under `/admin/*` (dashboard) and the unauthenticated `/api/sessions`,
`/api/proxies` CRUD expose credentials/session data — consider putting them
behind an IP allowlist or basic auth at the nginx layer if this box is
publicly reachable long-term.

## Redeploying after a code change

```bash
cd /opt/getigfeed
git pull
docker compose up -d --build
```

## Troubleshooting

- `docker compose logs -f getigfeed` — app logs.
- `sudo nginx -t` — validate nginx config after any edit.
- `sudo certbot certificates` — check cert expiry/status.
- `curl -s http://127.0.0.1:3000/api/anonyig/status` — chunk/proxy diagnostics
  from Step 2's notes, run directly against the container bypassing nginx.
