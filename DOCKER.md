# Docker Operations & Command Reference for GetIGFeed

This guide contains all Docker and Docker Compose commands for building, running, managing, debugging, and maintaining **GetIGFeed** locally and on the VPS (`/opt/getigfeed`).

---

## 📑 Table of Contents
1. [Quick Daily Cheat Sheet](#1-quick-daily-cheat-sheet)
2. [Starting & Stopping](#2-starting--stopping)
3. [Rebuilding & Updating (VPS / Deployment)](#3-rebuilding--updating-vps--deployment)
4. [Logs & Monitoring](#4-logs--monitoring)
5. [Entering the Container (Shell Access)](#5-entering-the-container-shell-access)
6. [Testing & Health Checks](#6-testing--health-checks)
7. [Direct `docker` CLI Commands (Alternative to Compose)](#7-direct-docker-cli-commands-alternative-to-compose)
8. [Maintenance, Cleanup & Disk Space](#8-maintenance-cleanup--disk-space)
9. [FeedPilot Docker Commands (Related Bridge)](#9-feedpilot-docker-commands-related-bridge)

---

## 1. Quick Daily Cheat Sheet

Run these commands inside the project directory (`/opt/getigfeed` on VPS, or project root locally):

| Action | Command |
|---|---|
| **Start in background** | `docker compose up -d` |
| **Stop container** | `docker compose stop` |
| **Restart container** | `docker compose restart` |
| **Check container status** | `docker compose ps` |
| **Live logs (tail 50 lines)** | `docker compose logs -f --tail=50` |
| **Rebuild after code change** | `docker compose up -d --build` |
| **Stop and remove container** | `docker compose down` |
| **Enter container shell** | `docker compose exec getigfeed sh` |

---

## 2. Starting & Stopping

### Start the service in background (detached mode)
```bash
docker compose up -d
```

### Stop the service without removing containers
```bash
docker compose stop
```

### Start stopped containers
```bash
docker compose start
```

### Restart the service
```bash
docker compose restart
```

### Stop and remove containers and network
```bash
docker compose down
```

---

## 3. Rebuilding & Updating (VPS / Deployment)

When you pull new code or change files, dependencies, or `.env`:

### Standard Update & Rebuild
```bash
cd /opt/getigfeed
git pull
docker compose up -d --build --remove-orphans
```

### Force Clean Rebuild (Ignoring Docker build cache)
```bash
docker compose build --no-cache
docker compose up -d --force-recreate
```

### Restart with environment variable (`.env`) reload
```bash
docker compose down
docker compose up -d
```

---

## 4. Logs & Monitoring

### Stream live logs (follow)
```bash
docker compose logs -f
```

### Stream last 100 lines with timestamps
```bash
docker compose logs -f --tail=100 -t
```

### Check status and health
```bash
docker compose ps
# or
docker ps -a --filter "name=getigfeed"
```

### View container resource usage (CPU, Memory, Network I/O)
```bash
docker stats getigfeed
```

---

## 5. Entering the Container (Shell Access)

Because GetIGFeed runs on `node:20-alpine`, use `sh` (Alpine does not install `bash` by default):

### Open an interactive shell inside the running container
```bash
docker compose exec getigfeed sh
# or via container name:
docker exec -it getigfeed sh
```

### Useful commands once inside the container:
```sh
# Check current directory and files
pwd
ls -la

# Verify environment variables
env

# Test health internally
wget -qO- http://127.0.0.1:3000/health
# or
node -e "require('http').get('http://127.0.0.1:3000/health', r => console.log('Status:', r.statusCode))"

# Exit container shell
exit
```

### Run a single one-off command without opening a shell
```bash
docker compose exec getigfeed node -v
docker compose exec getigfeed ls -la /app/data
```

---

## 6. Testing & Health Checks

### Check local health endpoint from host
```bash
curl -i http://127.0.0.1:3000/health
```

### Check Docker's internal health check inspection
```bash
docker inspect --format='{{json .State.Health}}' getigfeed | jq
```

### Test user feed endpoint
```bash
curl -i "http://127.0.0.1:3000/api/user-feed?username=instagram"
```

---

## 7. Direct `docker` CLI Commands (Alternative to Compose)

If you need to manage the container without `docker-compose.yml`:

### Build image manually
```bash
docker build -t getigfeed:latest .
```

### Run container manually with mounted data volume & env file
```bash
docker run -d \
  --name getigfeed \
  --restart unless-stopped \
  --init \
  -p 127.0.0.1:3000:3000 \
  --env-file .env \
  -v "$(pwd)/data:/app/data" \
  getigfeed:latest
```

### Container lifecycle controls
```bash
# Restart
docker restart getigfeed

# Stop
docker stop getigfeed

# Start
docker start getigfeed

# View logs
docker logs -f --tail 50 getigfeed

# Kill immediately
docker kill getigfeed

# Delete stopped container
docker rm getigfeed
```

---

## 8. Maintenance, Cleanup & Disk Space

Over time, repeated builds on VPS can consume disk space with unused layers and old images.

### Check Docker disk space usage
```bash
docker system df
```

### Remove dangling / unused images
```bash
docker image prune -f
```

### Complete system cleanup (removes stopped containers, dangling images, unused networks)
```bash
# Safe cleanup (keeps active volumes intact)
docker system prune -f
```

### Backup local data volume
GetIGFeed stores sessions and pool data in `./data` (`/app/data` inside container):
```bash
# Create timestamped tar backup
tar -czvf "getigfeed_data_$(date +%F_%H%M%S).tar.gz" ./data
```

---

## 9. FeedPilot Docker Commands (Related Bridge)

If you are running or testing the companion **FeedPilot** backend in Docker:

### Build FeedPilot backend Docker image
```bash
cd C:\CoreProjects\FeedPilot\backend   # or VPS path
docker build -t feedpilot-api:latest -f Dockerfile .
```

### Run FeedPilot container connected to PostgreSQL
```bash
docker run -d \
  --name feedpilot-api \
  --restart unless-stopped \
  -p 5000:8080 \
  -e ASPNETCORE_ENVIRONMENT=Production \
  -e DATABASE_URL="postgres://user:password@host:5432/feedpilot" \
  -e Jwt__Secret="your-32-character-secret-key-here" \
  -e Admin__ApiKey="your-admin-key" \
  -e FEEDPILOT_BRIDGE_KEY="your-bridge-key" \
  feedpilot-api:latest
```

### Test FeedPilot health
```bash
curl -i http://localhost:5000/health
```
