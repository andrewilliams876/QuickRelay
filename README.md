# QuickRelay

QuickRelay is a simple LAN clipboard tool.

Open it on two or more devices, paste text into one, and it shows up on the others instantly. No accounts, no cloud, just real-time sync on your local network.


## How it works

QuickRelay runs as a single server on your LAN.

- Open the app in your browser on any device
- All connected clients share the same live text surface
- Changes sync in real time over WebSockets

Example:

http://<SERVER_LAN_IP>:3000


## Quick Start

```bash
docker compose up --build -d
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

- `3000/tcp` — Web UI  
- `3001/tcp` — WebSocket sync  


## Configuration

### Core

- `NODE_ENV=production`  
  Run in production mode for stable deployments  

- `WS_HOST=0.0.0.0`  
  Allows the WebSocket server to accept connections from outside the container  


### Networking

- `WS_PUBLIC_PATH=/ws`  
  Use when running behind a reverse proxy on the same domain  

- `WS_PUBLIC_URL=`  
  Optional full override (e.g. `wss://quickrelay.example.com/ws`)  

- `LOCAL_NODE_IP=192.168.x.x`  
  Forces which IP is shown as the server identity  


### Access control

- `ACCESS_PIN=`  
  Optional shared passphrase required before clients can connect  


### Behaviour

- `DISCOVERY_ENABLED=false`  
  Recommended for single-server setups  

- `CLUSTER_STATE_INTERVAL_MS=1500`  
  UI refresh interval for session/client state  


## Reverse Proxy (Nginx Proxy Manager)

Use a single HTTPS domain.

### Proxy host

- Domain → `http://<server-ip>:3000`  
- WebSocket support: ON  
- Force SSL: ON  

### Custom location

- `/ws` → `http://<server-ip>:3001`  
- WebSocket support: ON  

### App config

```bash
WS_PUBLIC_PATH=/ws
WS_PUBLIC_URL=
ACCESS_PIN=your-secret
```


## Notes

- Clipboard APIs may be restricted on plain HTTP depending on browser policy  
- Sync still works even if direct clipboard access is blocked  
- For full clipboard support, use HTTPS or localhost  
- If Docker networking shows the wrong IP, you can override it in the UI  
- WebSocket auth uses short-lived tokens — use HTTPS/WSS to protect them  


## Summary

QuickRelay is built to stay simple:

- copy text  
- see it instantly on another device  
- keep everything inside your LAN  
- run it anywhere with Docker  

No accounts, no external services, no unnecessary complexity.
