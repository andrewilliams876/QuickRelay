import { WebSocket, WebSocketServer } from "ws";

type ClipboardUpdateMessage = {
  type: "clipboard_update";
  text: string;
  clientId: string;
  timestamp: number;
};

const port = Number(process.env.WS_PORT ?? 3001);
const host = process.env.WS_HOST ?? "0.0.0.0";
const clients = new Set<WebSocket>();
let latestMessage: ClipboardUpdateMessage | null = null;

const server = new WebSocketServer({ host, port });

function isClipboardUpdateMessage(input: unknown): input is ClipboardUpdateMessage {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const payload = input as Partial<ClipboardUpdateMessage>;
  return (
    payload.type === "clipboard_update" &&
    typeof payload.text === "string" &&
    typeof payload.clientId === "string" &&
    typeof payload.timestamp === "number"
  );
}

server.on("connection", (socket) => {
  clients.add(socket);

  if (latestMessage) {
    socket.send(JSON.stringify(latestMessage));
  }

  socket.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!isClipboardUpdateMessage(parsed)) {
      return;
    }

    latestMessage = parsed;

    for (const client of clients) {
      if (client !== socket && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(parsed));
      }
    }
  });

  socket.on("close", () => {
    clients.delete(socket);
  });

  socket.on("error", () => {
    clients.delete(socket);
  });
});

server.on("listening", () => {
  console.log(`[lan-clipboard] WebSocket server listening on ws://${host}:${port}`);
});

server.on("error", (error) => {
  console.error("[lan-clipboard] WebSocket server error:", error);
});

const shutdown = () => {
  console.log("[lan-clipboard] Shutting down websocket server...");
  for (const client of clients) {
    client.close(1001, "Server shutting down");
  }
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
