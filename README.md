# LAN Clipboard (Remix + shadcn-style UI)

Realtime text clipboard sync across devices on the same LAN.

## Stack

- Remix (React + TypeScript)
- Tailwind + shadcn-style component primitives
- WebSocket backend (`ws`)
- Docker / Docker Compose

## What it does

- Polls your local clipboard for text updates.
- Broadcasts updates to peers over LAN websocket server.
- Applies incoming text to clipboard automatically when browser permissions allow it.

## Quick start (Docker)

```bash
docker compose up --build
```

Open on each PC:

```text
http://<SERVER_LAN_IP>:3000
```

WebSocket endpoint is:

```text
ws://<SERVER_LAN_IP>:3001
```

## Local development

```bash
npm install
npm run dev
```

## Notes on automatic clipboard behavior

Browsers apply security restrictions to `navigator.clipboard` APIs:

- Some browsers require HTTPS (or localhost) for read/write.
- Permission prompts may appear the first time.
- If blocked, the text box still syncs across devices, and manual copy remains available.
