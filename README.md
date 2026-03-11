# QuickRelay (Remix + shadcn-style UI)

Realtime text clipboard sync across devices on the same LAN.

## Recommended Architecture

Run one server instance, then open that same URL from every PC.

```text
http://<SERVER_LAN_IP>:3000
```

No peer discovery or cross-server linking is required for this mode.

## Features

- Shared clipboard textbox sync for all connected clients.
- Per-client identity (`name + IP`) shown in Session Stats.
- Local client rename support from the UI.
- Dockerized deployment.

## Quick Start

```bash
docker compose up --build -d
docker compose logs -f
```

## Ports

- `3000/tcp`: Remix UI
- `3001/tcp`: WebSocket sync

## Important Environment Flags

- `LOCAL_NODE_IP=10.50.100.13` force which IP is shown as local on that server.
- `DISCOVERY_ENABLED=false` keep single-server mode.
- `CLUSTER_STATE_INTERVAL_MS=1500` client/health UI refresh interval.
- `WS_PUBLIC_PATH=/ws` for reverse-proxy websocket path on same HTTPS domain.
- `WS_PUBLIC_URL=wss://quickrelay.example.com/ws` optional explicit websocket URL override.
- Direct IP access is still supported: `http://<server-ip>:3000` will automatically use `ws://<server-ip>:3001`.

## Reverse Proxy (Nginx Proxy Manager)

Use one HTTPS domain and route:

- Proxy Host:
: domain -> app `http://<server-ip>:3000`
: websocket support ON
: force SSL ON

- Custom Location:
: `/ws` -> `http://<server-ip>:3001`
: websocket support ON

App config:

- `WS_PUBLIC_PATH=/ws`
- keep `WS_PUBLIC_URL=` empty unless you want explicit override.

## Notes

- Clipboard browser APIs can be restricted on plain HTTP depending on browser policy.
- Textbox syncing still works even when direct clipboard read/write is blocked.
- If a client IP resolves to a Docker bridge address, set `Device IP` in the UI and save identity.
- For full clipboard read/write on remote devices, use HTTPS (or localhost).

