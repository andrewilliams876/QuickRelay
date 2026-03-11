# LAN Clipboard (Remix + shadcn-style UI)

Realtime text clipboard sync across devices on the same LAN.

## Stack

- Remix (React + TypeScript)
- Tailwind + shadcn-style component primitives
- WebSocket backend (`ws`)
- UDP peer auto-discovery + static peer seeding
- Docker / Docker Compose

## What it does

- Syncs shared text between browser tabs on different machines.
- Relays clipboard updates across server peers on your LAN.
- Deduplicates messages to avoid peer loops.
- Shows cluster stats and peer online status (IP + connected/offline).

## Quick start (Docker)

```bash
docker compose up --build -d
docker compose logs -f
```

Open on each PC:

```text
http://<SERVER_LAN_IP>:3000
```

## Ports

- `3000/tcp`: Remix UI
- `3001/tcp`: WebSocket sync
- `4001/udp`: Peer discovery broadcast

## Environment flags

- `PEER_SEEDS=10.50.100.13:3001,10.50.100.6:3001` for deterministic peer linking
- `LOCAL_NODE_IP=10.50.100.13` forces which IP is shown as local on that machine
- `DISCOVERY_ENABLED=true` enables UDP auto-discovery
- `CLUSTER_STATE_INTERVAL_MS=1500` controls peer/status UI refresh interval

## Troubleshooting

- Open firewall for `3000/tcp`, `3001/tcp`, `4001/udp` on every machine.
- If discovery does not work on your Docker/network setup, keep `PEER_SEEDS` populated.
- Clipboard APIs can still be browser-restricted on plain HTTP. Textbox sync still works as fallback.
