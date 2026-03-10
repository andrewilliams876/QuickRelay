import type { MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import { Textarea } from "../components/ui/textarea";

type ClipboardUpdateMessage = {
  type: "clipboard_update";
  text: string;
  clientId: string;
  timestamp: number;
};

type PermissionLevel = "checking" | "granted" | "limited" | "blocked";

export const meta: MetaFunction = () => {
  return [{ title: "LAN Clipboard | Sync Text Between PCs" }];
};

export async function loader() {
  return json({
    wsPort: process.env.WS_PORT ?? "3001"
  });
}

function makeClientId() {
  if (typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto) {
    return globalThis.crypto.randomUUID();
  }
  return `client-${Math.random().toString(36).slice(2, 11)}`;
}

export default function Index() {
  const { wsPort } = useLoaderData<typeof loader>();

  const [clipboardText, setClipboardText] = useState("");
  const [statusText, setStatusText] = useState("Connecting to LAN sync server...");
  const [isConnected, setIsConnected] = useState(false);
  const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>("checking");
  const [lastRemoteUpdate, setLastRemoteUpdate] = useState<string | null>(null);
  const [updatesSent, setUpdatesSent] = useState(0);
  const [clientId, setClientId] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const clipboardPollRef = useRef<number | null>(null);
  const lastClipboardRef = useRef("");
  const skipBroadcastUntilRef = useRef(0);
  const clientIdRef = useRef("");

  const wsUrl = useMemo(() => {
    if (typeof window === "undefined") {
      return "";
    }
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.hostname}:${wsPort}`;
  }, [wsPort]);

  const sendClipboard = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload: ClipboardUpdateMessage = {
      type: "clipboard_update",
      text,
      clientId: clientIdRef.current,
      timestamp: Date.now()
    };
    ws.send(JSON.stringify(payload));
    setUpdatesSent((value) => value + 1);
  }, []);

  const refreshPermissionState = useCallback(async () => {
    if (typeof navigator === "undefined") {
      return;
    }
    if (!("permissions" in navigator) || !navigator.permissions?.query) {
      setPermissionLevel("limited");
      return;
    }

    try {
      const clipboardRead = await navigator.permissions.query({
        name: "clipboard-read" as PermissionName
      });
      const clipboardWrite = await navigator.permissions.query({
        name: "clipboard-write" as PermissionName
      });
      const states = [clipboardRead.state, clipboardWrite.state];
      if (states.every((state) => state === "granted")) {
        setPermissionLevel("granted");
        return;
      }
      if (states.some((state) => state === "denied")) {
        setPermissionLevel("blocked");
        return;
      }
      setPermissionLevel("limited");
    } catch {
      setPermissionLevel("limited");
    }
  }, []);

  const applyRemoteClipboard = useCallback(async (incomingText: string, timestamp: number) => {
    lastClipboardRef.current = incomingText;
    skipBroadcastUntilRef.current = Date.now() + 2_000;
    setClipboardText(incomingText);
    setLastRemoteUpdate(new Date(timestamp).toLocaleTimeString());

    if (!navigator.clipboard?.writeText) {
      setStatusText("Remote text received. Clipboard write API is unavailable.");
      return;
    }

    try {
      await navigator.clipboard.writeText(incomingText);
      setStatusText("Remote clipboard update applied automatically.");
    } catch {
      setStatusText("Remote text received, but browser blocked clipboard write.");
    }
  }, []);

  const pollLocalClipboard = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      setPermissionLevel("blocked");
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      if (text === lastClipboardRef.current) {
        return;
      }

      lastClipboardRef.current = text;
      setClipboardText(text);

      if (Date.now() >= skipBroadcastUntilRef.current) {
        sendClipboard(text);
        setStatusText("Local clipboard detected and shared.");
      }
    } catch {
      setStatusText("Clipboard read blocked by browser permissions.");
      setPermissionLevel((current) => (current === "granted" ? "limited" : current));
    }
  }, [sendClipboard]);

  useEffect(() => {
    if (!wsUrl) {
      return;
    }

    let isCancelled = false;

    const connect = () => {
      if (isCancelled) {
        return;
      }

      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        if (isCancelled) {
          return;
        }
        setIsConnected(true);
        setStatusText("Connected. Watching clipboard changes.");
        void pollLocalClipboard();
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as Partial<ClipboardUpdateMessage>;
          if (payload.type !== "clipboard_update" || typeof payload.text !== "string") {
            return;
          }
          if (payload.clientId === clientIdRef.current) {
            return;
          }
          if (payload.text === lastClipboardRef.current) {
            return;
          }
          void applyRemoteClipboard(
            payload.text,
            typeof payload.timestamp === "number" ? payload.timestamp : Date.now()
          );
        } catch {
          setStatusText("Received malformed sync payload.");
        }
      };

      socket.onclose = () => {
        if (isCancelled) {
          return;
        }
        setIsConnected(false);
        setStatusText("Disconnected. Reconnecting...");
        reconnectTimerRef.current = window.setTimeout(connect, 1_500);
      };

      socket.onerror = () => {
        setStatusText("WebSocket error. Retrying...");
      };
    };

    void refreshPermissionState();
    if (!clientIdRef.current) {
      const id = makeClientId();
      clientIdRef.current = id;
      setClientId(id);
    }
    connect();
    clipboardPollRef.current = window.setInterval(() => {
      void pollLocalClipboard();
    }, 1_100);

    return () => {
      isCancelled = true;
      if (clipboardPollRef.current !== null) {
        window.clearInterval(clipboardPollRef.current);
        clipboardPollRef.current = null;
      }
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
        wsRef.current.close();
      }
      wsRef.current = null;
    };
  }, [applyRemoteClipboard, pollLocalClipboard, refreshPermissionState, wsUrl]);

  const handleEnableClipboard = useCallback(async () => {
    try {
      if (!navigator.clipboard?.readText || !navigator.clipboard?.writeText) {
        setPermissionLevel("blocked");
        setStatusText("Clipboard API is not available in this browser.");
        return;
      }
      await navigator.clipboard.writeText(lastClipboardRef.current || "");
      const latest = await navigator.clipboard.readText();
      lastClipboardRef.current = latest;
      setClipboardText(latest);
      setPermissionLevel("granted");
      setStatusText("Clipboard permissions enabled.");
      sendClipboard(latest);
    } catch {
      setPermissionLevel("blocked");
      setStatusText("Clipboard permissions were denied.");
    }
  }, [sendClipboard]);

  const handleManualShare = useCallback(
    async (value: string) => {
      setClipboardText(value);
      lastClipboardRef.current = value;
      skipBroadcastUntilRef.current = 0;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
        }
      } catch {
        setStatusText("Shared to peers, but clipboard write is blocked locally.");
      }
      sendClipboard(value);
      setStatusText("Shared text to LAN peers.");
    },
    [sendClipboard]
  );

  const permissionBadgeVariant =
    permissionLevel === "granted" ? "success" : permissionLevel === "blocked" ? "warning" : "outline";

  const connectionBadgeVariant = isConnected ? "success" : "warning";

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-8 sm:px-8">
      <div className="pointer-events-none absolute -top-32 right-0 h-96 w-96 rounded-full bg-primary/15 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 left-4 h-80 w-80 rounded-full bg-accent/35 blur-3xl" />
      <section className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant={connectionBadgeVariant}>
                {isConnected ? "Realtime Connected" : "Server Offline"}
              </Badge>
              <Badge variant={permissionBadgeVariant}>
                {permissionLevel === "granted"
                  ? "Clipboard Access Ready"
                  : permissionLevel === "checking"
                    ? "Checking Permissions"
                    : permissionLevel === "limited"
                      ? "Permission Prompt Needed"
                      : "Clipboard Access Blocked"}
              </Badge>
            </div>
            <CardTitle>LAN Clipboard</CardTitle>
            <CardDescription>
              Copy text on one machine, it syncs over websocket, and applies on connected peers.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="block text-sm font-medium text-foreground/90" htmlFor="clipboard-mirror">
              Clipboard Mirror
            </label>
            <Textarea
              id="clipboard-mirror"
              value={clipboardText}
              placeholder="Clipboard text appears here and syncs to all connected devices."
              onChange={(event) => void handleManualShare(event.target.value)}
              className="font-mono text-xs"
            />
            <div className="rounded-lg border border-border/70 bg-background/70 p-3 font-mono text-xs text-muted-foreground">
              <div>Status: {statusText}</div>
              <div className="mt-1">WebSocket: {wsUrl || `ws://<host>:${wsPort}`}</div>
              <div className="mt-1">Local client id: {clientId || "initializing..."}</div>
            </div>
          </CardContent>
          <CardFooter className="flex flex-wrap gap-3">
            <Button onClick={() => void handleEnableClipboard()} variant="secondary">
              Enable Clipboard Access
            </Button>
            <Button onClick={() => void pollLocalClipboard()} variant="outline">
              Force Read Clipboard
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Session Stats</CardTitle>
            <CardDescription>Live health for this node.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Messages sent</span>
              <span className="font-mono text-foreground">{updatesSent}</span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Last remote update</span>
              <span className="font-mono text-foreground">{lastRemoteUpdate ?? "None yet"}</span>
            </div>
            <Separator />
            <div className="space-y-1">
              <p className="text-muted-foreground">How to use</p>
              <p className="text-xs text-foreground/90">
                Open this app on each PC in the LAN. Keep tabs active. Clipboard APIs may require HTTPS for full
                auto-read and auto-write behavior.
              </p>
            </div>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
