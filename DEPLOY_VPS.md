# Deploying to the Docker VPS (feed.reelsflow.io)

This is the companion to [DEPLOY.md](DEPLOY.md) (which covers Render) for the
self-managed VPS at `200.234.41.82`. It uses:

- [`Dockerfile`](Dockerfile) — builds the API image (Node 20 Alpine).
- [`docker-compose.yml`](docker-compose.yml) — runs the container, bound to
  `127.0.0.1:3000` only.
- [`deploy/nginx-feed.reelsflow.io.conf`](deploy/nginx-feed.reelsflow.io.conf) —
  host-nginx reverse proxy + TLS termination for the domain.
- [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) — CI/CD:
  every push to `main` rebuilds and restarts the container on the VPS.

## Server state (as found)

The VPS (`srv1922103`, Ubuntu 24.04, Docker 29.7.2 / Compose v5.5.0) already
runs an unrelated stack: `social-shorts-frontend` (5173), `-backend` (4000),
`-worker`, Postgres (5433), Redis (6379) — all left untouched by this deploy.
Host nginx (not containerized) is already running and terminates TLS for
existing sites via certbot.

**`app.reelsflow.io` is already in use** — its nginx config proxies to
`social-shorts-frontend:5173` with a valid cert. GetIGFeed is deployed on a
**separate subdomain, `feed.reelsflow.io`**, on container port `3000`, so it
cannot collide with that app.

### DNS — action needed once

`reelsflow.io`'s root domain resolves elsewhere and `feed.reelsflow.io` does
not resolve yet. Add an **A record**: `feed` → `200.234.41.82`, at whatever
provider manages `reelsflow.io`'s DNS, before running the certbot step below
(HTTP works immediately after Step 5; TLS needs DNS to have propagated).

## Step 0 — check what's already on ports 80/443

Already confirmed on this box: nginx owns 80/443 directly (not in Docker),
and port 3000 is free. Re-check before re-running this if the server has
changed:

```bash
docker ps
sudo ss -tlnp | grep -E ':80|:443|:3000'
```

## Step 1 — get the code onto the server

```bash
mkdir -p /opt/getigfeed && cd /opt/getigfeed
git clone https://github.com/RiyaazAli786/GetIGFeed.git .
```

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
the bottom of [DEPLOY.md](DEPLOY.md) for what each one does. Two notes carry
over from Render because this VPS is also a datacenter host:

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

## Step 4 — install certbot (nginx is already installed on this box)

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
```

## Step 5 — reverse proxy + TLS

```bash
sudo cp deploy/nginx-feed.reelsflow.io.conf /etc/nginx/sites-available/feed.reelsflow.io
sudo ln -s /etc/nginx/sites-available/feed.reelsflow.io /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

At this point `http://feed.reelsflow.io/health` should work once its DNS
record resolves. Then get the cert (needs DNS to have propagated):

```bash
sudo certbot --nginx -d feed.reelsflow.io
```

Certbot rewrites the config in place to add the 443 server block and sets up
auto-renewal (`certbot renew` via systemd timer/cron — check with
`systemctl list-timers | grep certbot`).

## Step 6 — verify

```bash
curl -s https://feed.reelsflow.io/health
curl -s https://feed.reelsflow.io/api/anonyig/user/nasa
curl -s https://feed.reelsflow.io/api/anonyig/feed/nasa
```

Then open `https://feed.reelsflow.io/admin` in a browser, enter the
`ADMIN_PASSCODE` from Step 2, and add sessions/proxies as needed.

## CI/CD — auto-deploy on push to `main`

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) SSHes into the
VPS on every push to `main` and runs `git reset --hard origin/main &&
docker compose up -d --build`. It authenticates as a dedicated low-privilege
`deploy` user (not root), created for this purpose:

```bash
# on the VPS, one-time setup
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy
sudo mkdir -p /home/deploy/.ssh
echo '<contents of getigfeed_deploy.pub>' | sudo tee /home/deploy/.ssh/authorized_keys
sudo chmod 700 /home/deploy/.ssh && sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh
sudo chown -R deploy:deploy /opt/getigfeed
```

In the GitHub repo → **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | `200.234.41.82` |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | the deploy keypair's **private** key (`getigfeed_deploy`, no passphrase) |

The `deploy` user only needs `docker` group membership (to build/run
containers) and ownership of `/opt/getigfeed` — it does not touch nginx, so
the one-time DNS/certbot steps above stay manual. Root's password is not
used by CI/CD at all.

## Active URL list

Base URL: **`https://feed.reelsflow.io`**

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

Automatic: push to `main` and the CI/CD workflow above handles it. Manually:

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
