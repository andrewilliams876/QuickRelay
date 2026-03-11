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
  messageId?: string;
  originServerId?: string;
};

type ClusterLocalNode = {
  displayAddress: string;
  addresses: string[];
  wsPort: number;
  online: true;
};

type ClusterClient = {
  clientId: string;
  clientName: string;
  ip: string;
  connectedAt: number;
  lastSeen: number;
};

type ClientHelloMessage = {
  type: "client_hello";
  clientId: string;
  clientName: string;
  clientIpHint?: string;
};

type ClusterStateMessage = {
  type: "cluster_state";
  serverId: string;
  connectedClients: number;
  totalMessages: number;
  lastClipboardTimestamp: number | null;
  localNode: ClusterLocalNode;
  clients: ClusterClient[];
};

type PermissionLevel = "checking" | "granted" | "limited" | "blocked";
type WsInboundMessage = ClipboardUpdateMessage | ClusterStateMessage;

type AccessTokenApiResponse = {
  token?: string;
  expiresAt?: number | null;
  authRequired?: boolean;
  error?: string;
};

export const meta: MetaFunction = () => {
  return [{ title: "QuickRelay | Sync Text Between PCs" }];
};

export async function loader() {
  return json({
    wsPort: process.env.WS_PORT ?? "3001",
    wsPublicPath: process.env.WS_PUBLIC_PATH ?? "",
    wsPublicUrl: process.env.WS_PUBLIC_URL ?? "",
    authRequired: Boolean((process.env.ACCESS_PIN ?? "").trim())
  });
}

function resolveWebSocketUrl({
  wsPort,
  wsPublicPath,
  wsPublicUrl,
  accessToken
}: {
  wsPort: string;
  wsPublicPath: string;
  wsPublicUrl: string;
  accessToken: string;
}) {
  return buildWebSocketCandidates({ wsPort, wsPublicPath, wsPublicUrl, accessToken })[0] ?? "";
}

function isIpv4Host(hostname: string) {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function isDirectHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || isIpv4Host(hostname);
}

function withAccessToken(urlValue: string, accessToken: string) {
  const token = accessToken.trim();
  if (!token) {
    return urlValue;
  }
  try {
    const url = new URL(urlValue);
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return urlValue;
  }
}

function buildWebSocketCandidates({
  wsPort,
  wsPublicPath,
  wsPublicUrl,
  accessToken
}: {
  wsPort: string;
  wsPublicPath: string;
  wsPublicUrl: string;
  accessToken: string;
}) {
  if (typeof window === "undefined") {
    return [];
  }

  const candidates: string[] = [];
  const trimmedPublicUrl = wsPublicUrl.trim();
  if (trimmedPublicUrl) {
    if (trimmedPublicUrl.startsWith("ws://") || trimmedPublicUrl.startsWith("wss://")) {
      candidates.push(trimmedPublicUrl);
      return candidates.map((candidate) => withAccessToken(candidate, accessToken));
    }
    if (trimmedPublicUrl.startsWith("http://")) {
      candidates.push(`ws://${trimmedPublicUrl.slice("http://".length)}`);
      return candidates.map((candidate) => withAccessToken(candidate, accessToken));
    }
    if (trimmedPublicUrl.startsWith("https://")) {
      candidates.push(`wss://${trimmedPublicUrl.slice("https://".length)}`);
      return candidates.map((candidate) => withAccessToken(candidate, accessToken));
    }
    candidates.push(trimmedPublicUrl);
    return candidates.map((candidate) => withAccessToken(candidate, accessToken));
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const directUrl = `${protocol}://${window.location.hostname}:${wsPort}`;
  const trimmedPublicPath = wsPublicPath.trim();
  if (trimmedPublicPath && !isDirectHost(window.location.hostname)) {
    const normalizedPath = trimmedPublicPath.startsWith("/")
      ? trimmedPublicPath
      : `/${trimmedPublicPath}`;
    candidates.push(`${protocol}://${window.location.host}${normalizedPath}`);
    if (!candidates.includes(directUrl)) {
      candidates.push(directUrl);
    }
    return candidates.map((candidate) => withAccessToken(candidate, accessToken));
  }

  candidates.push(directUrl);
  return candidates.map((candidate) => withAccessToken(candidate, accessToken));
}

function sanitizeWsUrlForDisplay(urlValue: string) {
  try {
    const url = new URL(urlValue);
    if (url.searchParams.has("token")) {
      url.searchParams.set("token", "***");
    }
    return url.toString();
  } catch {
    return urlValue;
  }
}

async function requestAccessTokenFromPin(pin: string) {
  const response = await fetch("/api/access-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ pin: pin.trim() })
  });

  const payload = (await response.json().catch(() => null)) as AccessTokenApiResponse | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? "Invalid access PIN.");
  }

  const token = (payload?.token ?? "").trim();
  if (!token) {
    throw new Error("Access token was not issued by server.");
  }

  return {
    token,
    expiresAt: payload?.expiresAt ?? null
  };
}
function makeClientId() {
  if (typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto) {
    return globalThis.crypto.randomUUID();
  }
  return `client-${Math.random().toString(36).slice(2, 11)}`;
}

function makeDefaultClientName() {
  const platform =
    typeof navigator !== "undefined" && navigator.platform
      ? navigator.platform.replace(/\s+/g, "")
      : "Client";
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${platform}-${suffix}`;
}

async function detectDeviceIp(): Promise<string | null> {
  if (typeof window === "undefined") {
    return null;
  }
  const rtcCtor =
    (window as unknown as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection ??
    (window as unknown as { webkitRTCPeerConnection?: typeof RTCPeerConnection }).webkitRTCPeerConnection;
  if (!rtcCtor) {
    return null;
  }

  return new Promise<string | null>((resolve) => {
    const ips = new Set<string>();
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve(selectBestIp(Array.from(ips)));
    }, 1800);

    const pc = new rtcCtor({ iceServers: [] });
    pc.createDataChannel("quickrelay");

    const captureIps = (text: string | null | undefined) => {
      if (!text) {
        return;
      }
      const regex = /(\d{1,3}(?:\.\d{1,3}){3})/g;
      const matches = text.match(regex) ?? [];
      for (const candidate of matches) {
        if (isValidClientIp(candidate)) {
          ips.add(candidate);
        }
      }
    };

    const cleanup = () => {
      window.clearTimeout(timeout);
      pc.onicecandidate = null;
      pc.close();
    };

    pc.onicecandidate = (event) => {
      captureIps(event.candidate?.candidate);
      if (!event.candidate) {
        cleanup();
        resolve(selectBestIp(Array.from(ips)));
      }
    };

    void pc
      .createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        captureIps(pc.localDescription?.sdp);
      })
      .catch(() => {
        cleanup();
        resolve(null);
      });
  });
}

function isValidClientIp(raw: string) {
  const value = raw.trim();
  const match = value.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
  if (!match) {
    return false;
  }
  const octets = value.split(".").map((part) => Number(part));
  if (octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  if (value === "0.0.0.0" || value.startsWith("127.") || value.startsWith("169.254.")) {
    return false;
  }
  return true;
}

function scoreIp(ip: string) {
  if (ip.startsWith("10.")) {
    return 50;
  }
  if (ip.startsWith("192.168.")) {
    return 45;
  }
  const secondOctet = Number(ip.split(".")[1] ?? "0");
  if (ip.startsWith("172.") && secondOctet >= 16 && secondOctet <= 31) {
    return 40;
  }
  return 20;
}

function selectBestIp(ips: string[]) {
  if (ips.length === 0) {
    return null;
  }
  const sorted = [...ips].sort((left, right) => scoreIp(right) - scoreIp(left));
  return sorted[0] ?? null;
}

export default function Index() {
  const { wsPort, wsPublicPath, wsPublicUrl, authRequired } = useLoaderData<typeof loader>();

  const [clipboardText, setClipboardText] = useState("");
  const [statusText, setStatusText] = useState("Connecting to LAN sync server...");
  const [isConnected, setIsConnected] = useState(false);
  const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>("checking");
  const [lastRemoteUpdate, setLastRemoteUpdate] = useState<string | null>(null);
  const [localMessagesSent, setLocalMessagesSent] = useState(0);
  const [clusterMessagesSeen, setClusterMessagesSeen] = useState(0);
  const [clusterConnectedClients, setClusterConnectedClients] = useState(0);
  const [clusterServerId, setClusterServerId] = useState<string | null>(null);
  const [connectedClients, setConnectedClients] = useState<ClusterClient[]>([]);
  const [localNode, setLocalNode] = useState<ClusterLocalNode | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientName, setClientName] = useState("");
  const [deviceIp, setDeviceIp] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [accessPinInput, setAccessPinInput] = useState("");
  const [authGateLocked, setAuthGateLocked] = useState(authRequired);
  const [showAccessPin, setShowAccessPin] = useState(false);
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const clipboardPollRef = useRef<number | null>(null);
  const lastClipboardRef = useRef("");
  const skipBroadcastUntilRef = useRef(0);
  const clientIdRef = useRef("");
  const clientNameRef = useRef("");
  const deviceIpRef = useRef("");
  const accessTokenRef = useRef("");
  const lastUserEditAtRef = useRef(0);
  const lastTimestampByClientRef = useRef(new Map<string, number>());

  const wsUrl = useMemo(() => {
    const effectiveAccessToken = authRequired ? accessToken : "";
    return resolveWebSocketUrl({ wsPort, wsPublicPath, wsPublicUrl, accessToken: effectiveAccessToken });
  }, [accessToken, authRequired, wsPort, wsPublicPath, wsPublicUrl]);
  const wsCandidates = useMemo(() => {
    const effectiveAccessToken = authRequired ? accessToken : "";
    return buildWebSocketCandidates({
      wsPort,
      wsPublicPath,
      wsPublicUrl,
      accessToken: effectiveAccessToken
    });
  }, [accessToken, authRequired, wsPort, wsPublicPath, wsPublicUrl]);
  const connectAttemptRef = useRef(0);
  const [activeWsUrl, setActiveWsUrl] = useState("");

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
    setLocalMessagesSent((value) => value + 1);
  }, []);

  const sendClientHello = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (!clientIdRef.current || !clientNameRef.current) {
      return;
    }
    const payload: ClientHelloMessage = {
      type: "client_hello",
      clientId: clientIdRef.current,
      clientName: clientNameRef.current,
      clientIpHint: deviceIpRef.current || undefined
    };
    ws.send(JSON.stringify(payload));
  }, []);


  const persistAccessToken = useCallback(
    (token: string) => {
      const cleaned = token.trim();
      accessTokenRef.current = cleaned;
      setAccessToken(cleaned);
      setAuthGateLocked(authRequired && !cleaned);

      if (typeof window !== "undefined") {
        if (cleaned) {
          window.localStorage.setItem("quickRelayAccessToken", cleaned);
        } else {
          window.localStorage.removeItem("quickRelayAccessToken");
        }
      }
    },
    [authRequired]
  );

  const exchangeAccessPinForToken = useCallback(
    async (pinCandidate: string) => {
      if (!authRequired) {
        setAuthError("");
        persistAccessToken("");
        return true;
      }

      const cleanedPin = pinCandidate.trim();
      if (!cleanedPin) {
        setAuthError("Enter ACCESS_PIN to continue.");
        setAuthGateLocked(true);
        setShowPinDialog(true);
        setStatusText("ACCESS_PIN required before this client can join sync.");
        return false;
      }

      const previousToken = accessTokenRef.current.trim();
      setIsAuthSubmitting(true);
      setAuthError("");

      try {
        const issued = await requestAccessTokenFromPin(cleanedPin);
        persistAccessToken(issued.token);
        setAuthGateLocked(false);
        setShowPinDialog(false);
        setStatusText("Access PIN accepted. Connecting to QuickRelay...");
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid access PIN.";
        if (!previousToken) {
          persistAccessToken("");
          setAuthGateLocked(true);
          setShowPinDialog(true);
        } else {
          setAuthGateLocked(false);
        }
        setAuthError(message);
        setStatusText(message);
        return false;
      } finally {
        setIsAuthSubmitting(false);
      }
    },
    [authRequired, persistAccessToken]
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (!clientIdRef.current) {
      const id = makeClientId();
      clientIdRef.current = id;
      setClientId(id);
    } else {
      setClientId(clientIdRef.current);
    }

    const stored =
      window.localStorage.getItem("quickRelayClientName") ??
      window.localStorage.getItem("lanClipboardClientName");
    const resolvedName = stored && stored.trim() ? stored.trim() : makeDefaultClientName();
    clientNameRef.current = resolvedName;
    setClientName(resolvedName);
    window.localStorage.setItem("quickRelayClientName", resolvedName);

    const storedIp =
      window.localStorage.getItem("quickRelayDeviceIp") ??
      window.localStorage.getItem("lanClipboardDeviceIp") ??
      "";
    if (storedIp && isValidClientIp(storedIp)) {
      deviceIpRef.current = storedIp;
      setDeviceIp(storedIp);
    }

    const storedAccessToken = window.localStorage.getItem("quickRelayAccessToken") ?? "";
    const resolvedAccessToken = authRequired ? storedAccessToken.trim() : "";
    accessTokenRef.current = resolvedAccessToken;
    setAccessToken(resolvedAccessToken);

    const requiresPin = authRequired && !resolvedAccessToken;
    setAuthGateLocked(requiresPin);
    setShowPinDialog(requiresPin);

    if (!authRequired) {
      window.localStorage.removeItem("quickRelayAccessToken");
    }

    void detectDeviceIp().then((ip) => {
      if (!ip) {
        return;
      }
      deviceIpRef.current = ip;
      setDeviceIp(ip);
      window.localStorage.setItem("quickRelayDeviceIp", ip);
      sendClientHello();
    });
  }, [authRequired, sendClientHello]);

  useEffect(() => {
    if (!isConnected) {
      return;
    }
    sendClientHello();
  }, [isConnected, sendClientHello]);

  useEffect(() => {
    if (authRequired) {
      return;
    }

    setShowAccessPin(false);
    setShowPinDialog(false);
    setAuthError("");
    setIsAuthSubmitting(false);
    setAccessPinInput("");
    persistAccessToken("");
  }, [authRequired, persistAccessToken]);

  const refreshPermissionState = useCallback(async () => {
    if (typeof navigator === "undefined") {
      return;
    }
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setPermissionLevel("limited");
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

  const applyRemoteClipboard = useCallback(
    async (incomingText: string, timestamp: number, sourceClientId: string) => {
      const previousTimestamp = lastTimestampByClientRef.current.get(sourceClientId) ?? 0;
      if (timestamp < previousTimestamp) {
        return;
      }
      lastTimestampByClientRef.current.set(sourceClientId, timestamp);

      lastClipboardRef.current = incomingText;
      skipBroadcastUntilRef.current = Date.now() + 5_000;
      lastUserEditAtRef.current = Date.now();
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
    },
    []
  );

  const pollLocalClipboard = useCallback(async () => {
    if (!window.isSecureContext) {
      setPermissionLevel((current) => (current === "granted" ? current : "limited"));
      setStatusText("Clipboard auto-read requires HTTPS (or localhost). Text sync still works.");
      return;
    }
    if (permissionLevel !== "granted") {
      return;
    }
    if (Date.now() - lastUserEditAtRef.current < 15_000) {
      return;
    }
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      setPermissionLevel("blocked");
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      if (text === lastClipboardRef.current) {
        return;
      }

      if (text === "" && lastClipboardRef.current !== "") {
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
  }, [permissionLevel, sendClipboard]);

  useEffect(() => {
    if (wsCandidates.length === 0) {
      return;
    }

    let isCancelled = false;

    const connect = () => {
      if (isCancelled) {
        return;
      }

      const targetUrl = wsCandidates[connectAttemptRef.current % wsCandidates.length] ?? wsCandidates[0];
      connectAttemptRef.current += 1;
      setActiveWsUrl(targetUrl);
      const socket = new WebSocket(targetUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        if (isCancelled) {
          return;
        }
        setIsConnected(true);
        connectAttemptRef.current = 0;
        setStatusText("Connected. Watching clipboard changes.");
        setAuthGateLocked(false);
        sendClientHello();
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as Partial<WsInboundMessage>;
          if (payload.type === "cluster_state") {
            setClusterServerId(typeof payload.serverId === "string" ? payload.serverId : null);
            setClusterConnectedClients(
              typeof payload.connectedClients === "number" ? payload.connectedClients : 0
            );
            setClusterMessagesSeen(typeof payload.totalMessages === "number" ? payload.totalMessages : 0);
            setConnectedClients(
              Array.isArray(payload.clients) ? (payload.clients as ClusterClient[]) : []
            );
            const incomingLocal = payload.localNode as Partial<ClusterLocalNode> | undefined;
            if (
              incomingLocal &&
              typeof incomingLocal.displayAddress === "string" &&
              Array.isArray(incomingLocal.addresses) &&
              typeof incomingLocal.wsPort === "number"
            ) {
              setLocalNode({
                displayAddress: incomingLocal.displayAddress,
                addresses: incomingLocal.addresses.filter(
                  (value): value is string => typeof value === "string"
                ),
                wsPort: incomingLocal.wsPort,
                online: true
              });
            }
            if (typeof payload.lastClipboardTimestamp === "number") {
              setLastRemoteUpdate(new Date(payload.lastClipboardTimestamp).toLocaleTimeString());
            }
            return;
          }

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
            typeof payload.timestamp === "number" ? payload.timestamp : Date.now(),
            typeof payload.clientId === "string" ? payload.clientId : "unknown-client"
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
        setStatusText(authRequired ? "Disconnected. Reconnecting (check ACCESS_PIN if this persists)..." : "Disconnected. Reconnecting...");
        setAuthGateLocked(authRequired && !accessTokenRef.current.trim());
        reconnectTimerRef.current = window.setTimeout(connect, 1_500);
      };

      socket.onerror = () => {
        setStatusText(authRequired ? "WebSocket error or ACCESS_PIN rejected. Retrying..." : "WebSocket error. Retrying...");
      };
    };

    void refreshPermissionState();

    if (authRequired && !accessTokenRef.current.trim()) {
      setIsConnected(false);
      setAuthGateLocked(true);
      setShowPinDialog(true);
      setStatusText("ACCESS_PIN required before this client can join sync.");
      return;
    }

    connect();
    clipboardPollRef.current = window.setInterval(() => {
      if (!document.hidden) {
        void pollLocalClipboard();
      }
    }, 1_300);

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
  }, [applyRemoteClipboard, authRequired, pollLocalClipboard, refreshPermissionState, sendClientHello, wsCandidates]);

  const handleEnableClipboard = useCallback(async () => {
    try {
      if (!navigator.clipboard?.readText || !navigator.clipboard?.writeText) {
        setPermissionLevel("limited");
        setStatusText("Clipboard API is limited on this page. Use HTTPS or localhost for full access.");
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
      lastUserEditAtRef.current = Date.now();

      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
        }
      } catch {
        setStatusText("Shared to connected clients, but clipboard write is blocked locally.");
      }

      sendClipboard(value);
      setStatusText("Shared text to connected clients.");
    },
    [sendClipboard]
  );

  const handleSaveClientName = useCallback(async () => {
    if (typeof window === "undefined") {
      return;
    }

    const resolved = clientName.replace(/\s+/g, " ").trim().slice(0, 48) || makeDefaultClientName();
    const cleanedIp = deviceIp.trim();
    const cleanedPinInput = accessPinInput.trim();

    if (cleanedIp && !isValidClientIp(cleanedIp)) {
      setStatusText("Device IP must be a valid IPv4 address.");
      return;
    }

    if (authRequired && cleanedPinInput) {
      const authenticated = await exchangeAccessPinForToken(cleanedPinInput);
      if (!authenticated) {
        return;
      }
      setAccessPinInput("");
    }

    if (authRequired && !accessTokenRef.current.trim()) {
      setAuthGateLocked(true);
      setShowPinDialog(true);
      setStatusText("ACCESS_PIN required before this client can join sync.");
      return;
    }

    clientNameRef.current = resolved;
    deviceIpRef.current = cleanedIp;
    setClientName(resolved);
    setDeviceIp(cleanedIp);

    window.localStorage.setItem("quickRelayClientName", resolved);
    window.localStorage.setItem("quickRelayDeviceIp", cleanedIp);

    sendClientHello();
    setStatusText(authRequired ? "Client identity and auth token updated." : "Client identity updated.");
  }, [
    accessPinInput,
    authRequired,
    clientName,
    deviceIp,
    exchangeAccessPinForToken,
    sendClientHello
  ]);

  const handlePinDialogSubmit = useCallback(async () => {
    const authenticated = await exchangeAccessPinForToken(accessPinInput);
    if (authenticated) {
      setAccessPinInput("");
    }
  }, [accessPinInput, exchangeAccessPinForToken]);

  const permissionBadgeVariant =
    permissionLevel === "granted" ? "success" : permissionLevel === "blocked" ? "warning" : "outline";
  const connectionBadgeVariant = isConnected ? "success" : "warning";
  const accessBadgeVariant = !authRequired ? "outline" : authGateLocked ? "warning" : "success";
  const connectedClientCount = connectedClients.length;

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-8 sm:px-8">
      <div className="pointer-events-none absolute -top-32 right-0 h-96 w-96 rounded-full bg-primary/15 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 left-4 h-80 w-80 rounded-full bg-accent/35 blur-3xl" />

      {authRequired && showPinDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
            <h2 className="text-2xl font-semibold text-card-foreground">Enter Access PIN</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              This server requires an ACCESS_PIN before this client can join realtime sync.
            </p>
            <form
              className="mt-5 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handlePinDialogSubmit();
              }}
            >
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Access PIN
                <div className="relative">
                  <input
                    type={showAccessPin ? "text" : "password"}
                    autoComplete="current-password"
                    value={accessPinInput}
                    onChange={(event) => setAccessPinInput(event.target.value)}
                    autoFocus
                    className="h-10 w-full rounded-md border border-input bg-background px-3 pr-10 text-sm text-foreground"
                    placeholder="Enter ACCESS_PIN"
                  />
                  <button
                    type="button"
                    aria-label={showAccessPin ? "Hide PIN" : "Show PIN"}
                    onClick={() => setShowAccessPin((value) => !value)}
                    className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition hover:text-foreground"
                  >
                    {showAccessPin ? (
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M3 3l18 18" />
                        <path d="M10.6 10.6a2 2 0 002.8 2.8" />
                        <path d="M9.9 4.2A10.5 10.5 0 0112 4c7 0 10 8 10 8a16.4 16.4 0 01-4 5.3" />
                        <path d="M6.6 6.6A16.8 16.8 0 002 12s3 8 10 8a9.9 9.9 0 004.2-.9" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
              </label>
              {authError ? <p className="text-xs text-warning">{authError}</p> : null}
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setShowPinDialog(false);
                    setAuthError("");
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isAuthSubmitting}>
                  {isAuthSubmitting ? "Checking..." : "Continue"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

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
              <Badge variant={accessBadgeVariant}>
                {!authRequired ? "No Access PIN" : authGateLocked ? "Access PIN Required" : "Access PIN Accepted"}
              </Badge>
              {authRequired ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setShowPinDialog(true)}
                >
                  Enter PIN
                </Button>
              ) : null}
            </div>
            <CardTitle>QuickRelay</CardTitle>
            <CardDescription>
              Copy text on one machine, it syncs over websocket, and applies on connected clients.
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
              <div className="mt-1">WebSocket: {sanitizeWsUrlForDisplay(activeWsUrl || wsUrl || `ws://<host>:${wsPort}`)}</div>
              <div className="mt-1">
                Server IP: {localNode ? `${localNode.displayAddress}:${localNode.wsPort}` : "initializing..."}
              </div>
              <div className="mt-1">This device IP: {deviceIp || "unavailable"}</div>
              <div className="mt-1">Client name: {clientName || "initializing..."}</div>
              <div className="mt-1">Cluster server id: {clusterServerId ?? "initializing..."}</div>
              <div className="mt-1">Local client id: {clientId || "initializing..."}</div>
            </div>
            <div className="grid items-end gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Client label
                <input
                  value={clientName}
                  onChange={(event) => setClientName(event.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  placeholder="Set a client name"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Device IP (optional)
                <input
                  value={deviceIp}
                  onChange={(event) => setDeviceIp(event.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  placeholder="e.g. 10.50.100.13"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2 lg:col-span-1">
                Access PIN (optional)
                <div className="relative">
                  <input
                    type={showAccessPin ? "text" : "password"}
                    autoComplete="current-password"
                    value={authRequired ? accessPinInput : ""}
                    disabled={!authRequired}
                    onChange={(event) => setAccessPinInput(event.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 pr-10 text-sm text-foreground disabled:cursor-not-allowed disabled:bg-muted/40 disabled:text-muted-foreground disabled:opacity-70"
                    placeholder={authRequired ? "Enter ACCESS_PIN to refresh token" : "Disabled (ACCESS_PIN not set)"}
                  />
                  <button
                    type="button"
                    aria-label={showAccessPin ? "Hide PIN" : "Show PIN"}
                    disabled={!authRequired}
                    onClick={() => setShowAccessPin((value) => !value)}
                    className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {showAccessPin ? (
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M3 3l18 18" />
                        <path d="M10.6 10.6a2 2 0 002.8 2.8" />
                        <path d="M9.9 4.2A10.5 10.5 0 0112 4c7 0 10 8 10 8a16.4 16.4 0 01-4 5.3" />
                        <path d="M6.6 6.6A16.8 16.8 0 002 12s3 8 10 8a9.9 9.9 0 004.2-.9" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
              </label>
              <div className="sm:col-span-2 lg:col-span-1">
                <Button className="w-full lg:w-auto" size="sm" disabled={isAuthSubmitting} onClick={() => void handleSaveClientName()}>
                  Save Client Identity
                </Button>
              </div>
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
            <CardDescription>Live health for this server and connected clients.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Local messages sent</span>
              <span className="font-mono text-foreground">{localMessagesSent}</span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Cluster messages seen</span>
              <span className="font-mono text-foreground">{clusterMessagesSeen}</span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Clients on this server</span>
              <span className="font-mono text-foreground">{clusterConnectedClients}</span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Clients connected</span>
              <span className="font-mono text-foreground">
                {connectedClientCount}
              </span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Last remote update</span>
              <span className="font-mono text-foreground">{lastRemoteUpdate ?? "None yet"}</span>
            </div>
            <Separator />
            <div className="space-y-2">
              <p className="text-muted-foreground">Connected clients</p>
              {connectedClients.length === 0 ? (
                <p className="text-xs text-foreground/90">No connected clients yet.</p>
              ) : (
                <ul className="space-y-1">
                  {connectedClients.map((entry) => (
                    <li
                      key={`${entry.clientId}-${entry.ip}-${entry.connectedAt}`}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="inline-flex items-center gap-2 font-mono">
                        <span className="inline-block h-2 w-2 rounded-full bg-success" />
                        {entry.clientName}
                      </span>
                      <span className="text-success">
                        {entry.ip}
                        {entry.clientId === clientId ? " (you)" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}

