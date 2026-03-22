# QuickRelay

QuickRelay is a realtime LAN scratchpad with shared clipboard sync and persistent history.

## What it does

- Keeps a live scratchpad in sync across connected devices on the same LAN
- Stores shared history in SQLite so entries survive server restarts
- Lets you click history items to reuse them or copy them with one button
- Shows connected clients, device identity, and server health in the UI
- Supports an optional `ACCESS_PIN` gate for websocket access

## Recommended setup

Run one QuickRelay server on your network and open it from any device on the same LAN:

## How it works

This release is designed for the single-server LAN setup. Peer discovery can stay off unless you are intentionally linking multiple servers.

## Quick start

```bash
copy .env.example .env
docker compose pull
docker compose up -d
docker compose logs -f
```

Then open:

http://<your-server-ip>:3000


## Features

- Shared live clipboard textbox across all connected devices  
- Per-device identity (name + IP)  
- Client rename support from the UI  
- Optional `ACCESS_PIN` for gated LAN access  
- Works over LAN IP or behind a reverse proxy  
- Docker-ready deployment  


## Architecture

QuickRelay is designed to run as a single server.

- No peer discovery required  
- No multi-node clustering needed  
- Clients connect directly to the server  

This keeps setup simple and avoids sync conflicts.


## Ports

- `3000/tcp`: Web UI
- `3001/tcp`: WebSocket sync server

## Persistent history

QuickRelay now stores shared history in SQLite.

- Default container path: `/data/quickrelay-history.sqlite`
- Docker volume: `quickrelay_data`
- Default retention: last `50` entries

This means history survives:

- app restarts
- container restarts
- normal Docker rebuild/redeploy flows, as long as the volume is kept

## Important environment flags

- `NODE_ENV=production`
  Use this for normal Docker deployment. It tells the app to run in production mode instead of a hot-reload dev workflow.

- `WS_HOST=0.0.0.0`
  This makes the websocket server listen on all container interfaces so other LAN devices can reach it through Docker's published port mapping.

- `WS_PUBLIC_PATH=/ws`
  Use this when the browser should reach websockets through the same public domain as the app, for example behind Nginx Proxy Manager or another reverse proxy. The frontend will try `wss://your-domain/ws`.

- `WS_PUBLIC_URL=`
  Leave this empty in most setups. Set it only when you want to force a full websocket URL such as `wss://quickrelay.example.com/ws`. If this is set, it takes priority over `WS_PUBLIC_PATH`.

- `HISTORY_DB_PATH=/data/quickrelay-history.sqlite`
  Controls where the SQLite file lives. In Docker, keep this inside the mounted data volume so history persists.

- `MAX_HISTORY_ITEMS=50`
  Caps the stored history size. Older items are trimmed automatically after new entries are saved.

- `ACCESS_PIN=your-secret`
  Optional shared passphrase for client access. Clients unlock once per browser session and then connect with a signed short-lived websocket token.

- `LOCAL_NODE_IP=`
  Forces which IP address the UI shows as the server's LAN address. Set this if Docker or a bridge interface is being detected instead of the IP you actually want users to open.

- `DISCOVERY_ENABLED=false`
  Keep this false for the recommended single-server setup.

- `CLUSTER_STATE_INTERVAL_MS=1500`
  Controls how often the UI receives health/status refreshes.

## Reverse proxy example

If you are serving QuickRelay behind one HTTPS domain:

- Route the app domain to `http://<server-ip>:3000`
- Route `/ws` to `http://<server-ip>:3001`
- Turn websocket support on for both routes
- Set `WS_PUBLIC_PATH=/ws`
- Leave `WS_PUBLIC_URL=` empty unless you need a hard override

### Nginx Proxy Manager example

For Nginx Proxy Manager, the setup should look like this:

- Main proxy host
  - domain -> `http://<server-ip>:3000`
  - websocket support -> enabled
- Custom location
  - location -> `/ws`
  - forward host/IP -> `<server-ip>`
  - forward port -> `3001`
  - websocket support -> enabled

This is required because:

- QuickRelay app UI runs on port `3000`
- the QuickRelay websocket server runs separately on port `3001`
- `/ws` must be routed to the websocket server, not back to the QuickRelay app

If `/ws` is accidentally sent to port `3000`, QuickRelay will stay offline and your logs will show errors like:

```text
GET /ws 404
Error: No route matches URL "/ws"
```

That means the reverse proxy is forwarding the websocket path to the web app instead of the websocket server.

## Notes

- Clipboard read/write permissions can still be restricted by the browser on plain HTTP.
- The scratchpad and history UI still work even when direct clipboard APIs are limited.
- For the smoothest remote clipboard behavior, use HTTPS or localhost.
- History is shared per QuickRelay server instance in this version; it is not replicated across multiple server histories.
- Source code is licensed under MIT. Name, branding, and logo usage are described in [TERMS.md](./TERMS.md).

## CI/CD Docker publishing

This repo now includes a GitHub Actions workflow at [.github/workflows/docker-publish.yml](./.github/workflows/docker-publish.yml).

What it does:

- runs on every push to `main` and `dev`
- builds the Docker image from the root `Dockerfile`
- publishes the image to GitHub Container Registry
- pushes both:
  - `ghcr.io/andrewilliams876/quickrelay:latest` from `main`
  - `ghcr.io/andrewilliams876/quickrelay:dev` from `dev`
  - `ghcr.io/andrewilliams876/quickrelay:sha-<commit>` from either branch

Notes:

- it uses GitHub's built-in `GITHUB_TOKEN`, so you do not need to add Docker Hub credentials for this workflow
- if you want people outside the repo to pull the image, make the GitHub Container Registry package visible in your repo/package settings
- `latest` is reserved for `main`, while `dev` is reserved for the development branch so test pushes do not overwrite your stable tag

## Pulling published images

Use the published image that matches the branch you want to run:

- stable release from `main`
  - `ghcr.io/andrewilliams876/quickrelay:latest`
- testing build from `dev`
  - `ghcr.io/andrewilliams876/quickrelay:dev`

Example pulls:

```bash
docker pull ghcr.io/andrewilliams876/quickrelay:latest
docker pull ghcr.io/andrewilliams876/quickrelay:dev
```

## Using the published image in Docker Compose

This repo's [docker-compose.yml](./docker-compose.yml) is already set up to pull the published image using an env-controlled tag:

```yaml
image: ghcr.io/andrewilliams876/quickrelay:${QUICKRELAY_IMAGE_TAG:-latest}
```

That means you do not need to edit the compose file every time you switch branches. You only change the tag value in `.env`.

Use `.env` like this for stable `main`:

```env
QUICKRELAY_IMAGE_TAG=latest
```

Use `.env` like this for testing `dev`:

```env
QUICKRELAY_IMAGE_TAG=dev
```

If you prefer to hardcode the image directly, these are the equivalent tags:

Stable `main` image:

```yaml
services:
  quickrelay:
    image: ghcr.io/andrewilliams876/quickrelay:latest
```

Testing `dev` image:

```yaml
services:
  quickrelay:
    image: ghcr.io/andrewilliams876/quickrelay:dev
```

Important:

- this compose file now uses `image:` by default so it follows your published GitHub Container Registry builds
- switch between `main` and `dev` by changing `QUICKRELAY_IMAGE_TAG` in `.env`
- run `docker compose pull` before `docker compose up -d` when you want the newest published image
- if you ever want to go back to local builds, swap the `image:` line back to a `build:` block

## Suggested deployment flow

- working on new features
  - push to `dev`
  - set `QUICKRELAY_IMAGE_TAG=dev`
  - run `docker compose pull && docker compose up -d`
- ready for stable release
  - merge or push to `main`
  - set `QUICKRELAY_IMAGE_TAG=latest`
  - run `docker compose pull && docker compose up -d`
