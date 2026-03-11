# LAN Clipboard (Remix + shadcn-style UI)

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

## Notes

- Clipboard browser APIs can be restricted on plain HTTP depending on browser policy.
- Textbox syncing still works even when direct clipboard read/write is blocked.
