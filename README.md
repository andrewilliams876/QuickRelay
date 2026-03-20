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

```text
http://<SERVER_LAN_IP>:3000
```

This release is designed for the single-server LAN setup. Peer discovery can stay off unless you are intentionally linking multiple servers.

## Quick start

```bash
docker compose up --build -d
docker compose logs -f
```

## Ports

- `3000/tcp`: Remix UI
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

- `LOCAL_NODE_IP=10.50.100.13`
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

## Notes

- Clipboard read/write permissions can still be restricted by the browser on plain HTTP.
- The scratchpad and history UI still work even when direct clipboard APIs are limited.
- For the smoothest remote clipboard behavior, use HTTPS or localhost.
- History is shared per QuickRelay server instance in this version; it is not replicated across multiple server histories.
