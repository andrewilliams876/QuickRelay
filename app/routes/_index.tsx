import type { MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import { Textarea } from "../components/ui/textarea";

type ClipboardUpdateMessage = {
  type: "clipboard_update";
  text: string;
  clientId: string;
  timestamp: number;
  persistToHistory?: boolean;
  messageId?: string;
  originServerId?: string;
};

type ClipboardHistoryEntry = {
  id: string;
  text: string;
  createdAt: number;
  sourceClientId: string;
};

type HistorySnapshotMessage = {
  type: "history_snapshot";
  entries: ClipboardHistoryEntry[];
  maxItems: number;
};

type HistoryAppendMessage = {
  type: "history_append";
  entry: ClipboardHistoryEntry;
};

type HistoryClearMessage = {
  type: "history_clear";
  clearedAt: number;
};

type HistoryTruncateMessage = {
  type: "history_truncate";
  removedIds: string[];
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
type ThemeMode = "light" | "dark";
type WsInboundMessage =
  | ClipboardUpdateMessage
  | ClusterStateMessage
  | HistorySnapshotMessage
  | HistoryAppendMessage
  | HistoryClearMessage
  | HistoryTruncateMessage;

type AccessTokenApiResponse = {
  token?: string;
  expiresAt?: number | null;
  authRequired?: boolean;
  error?: string;
};

export const meta: MetaFunction = () => [{ title: "QuickRelay | Scratchpad + History" }];

export async function loader() {
  return json({
    wsPort: process.env.WS_PORT ?? "3001",
    wsPublicPath: process.env.WS_PUBLIC_PATH ?? "",
    wsPublicUrl: process.env.WS_PUBLIC_URL ?? "",
    authRequired: Boolean((process.env.ACCESS_PIN ?? "").trim()),
    maxHistoryItems: Number(process.env.MAX_HISTORY_ITEMS ?? 50)
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
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
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
    const normalizedPath = trimmedPublicPath.startsWith("/") ? trimmedPublicPath : `/${trimmedPublicPath}`;
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
    headers: { "Content-Type": "application/json" },
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

  return { token, expiresAt: payload?.expiresAt ?? null };
}

function makeClientId() {
  if (typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto) {
    return globalThis.crypto.randomUUID();
  }
  return `client-${Math.random().toString(36).slice(2, 11)}`;
}

function makeDefaultClientName() {
  const platform =
    typeof navigator !== "undefined" && navigator.platform ? navigator.platform.replace(/\s+/g, "") : "Client";
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
      const matches = text.match(/(\d{1,3}(?:\.\d{1,3}){3})/g) ?? [];
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
      .then(() => captureIps(pc.localDescription?.sdp))
      .catch(() => {
        cleanup();
        resolve(null);
      });
  });
}

function isValidClientIp(raw: string) {
  const value = raw.trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return false;
  }
  const octets = value.split(".").map((part) => Number(part));
  return !octets.some((part) => Number.isNaN(part) || part < 0 || part > 255) &&
    value !== "0.0.0.0" &&
    !value.startsWith("127.") &&
    !value.startsWith("169.254.");
}

function scoreIp(ip: string) {
  if (ip.startsWith("10.")) return 50;
  if (ip.startsWith("192.168.")) return 45;
  const secondOctet = Number(ip.split(".")[1] ?? "0");
  if (ip.startsWith("172.") && secondOctet >= 16 && secondOctet <= 31) return 40;
  return 20;
}

function selectBestIp(ips: string[]) {
  if (ips.length === 0) {
    return null;
  }
  return [...ips].sort((left, right) => scoreIp(right) - scoreIp(left))[0] ?? null;
}

function getSystemThemeMode(): ThemeMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getInitialThemeMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "light";
  }
  const storedTheme = window.localStorage.getItem("quickRelayThemeMode");
  return storedTheme === "dark" || storedTheme === "light" ? storedTheme : getSystemThemeMode();
}

function formatHistoryTimestamp(timestamp: number) {
  return new Date(timestamp).toLocaleString([], { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
}

function normalizeClipboardText(raw: string) {
  return raw.replace(/\r\n/g, "\n");
}

function renderMarkdownSegment(segment: string, keyPrefix: string) {
  return segment.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean).map((token, index) => {
    if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
      return <strong key={`${keyPrefix}-bold-${index}`}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith("*") && token.endsWith("*") && token.length > 2) {
      return <em key={`${keyPrefix}-italic-${index}`}>{token.slice(1, -1)}</em>;
    }
    return <Fragment key={`${keyPrefix}-text-${index}`}>{token}</Fragment>;
  });
}

function renderHistoryMarkdown(text: string) {
  return text.split("\n").map((line, lineIndex, lines) => (
    <Fragment key={`line-${lineIndex}`}>
      {line.split(/(https?:\/\/[^\s]+)/g).filter(Boolean).map((segment, segmentIndex) => {
        if (/^https?:\/\/[^\s]+$/.test(segment)) {
          return (
            <a
              key={`line-${lineIndex}-url-${segmentIndex}`}
              href={segment}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary underline decoration-primary/40 underline-offset-4"
              onClick={(event) => event.stopPropagation()}
            >
              {segment}
            </a>
          );
        }
        return (
          <Fragment key={`line-${lineIndex}-segment-${segmentIndex}`}>
            {renderMarkdownSegment(segment, `line-${lineIndex}-segment-${segmentIndex}`)}
          </Fragment>
        );
      })}
      {lineIndex < lines.length - 1 ? <br /> : null}
    </Fragment>
  ));
}

export default function Index() {
  const { wsPort, wsPublicPath, wsPublicUrl, authRequired, maxHistoryItems } = useLoaderData<typeof loader>();

  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
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
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState("");
  const [historyEntries, setHistoryEntries] = useState<ClipboardHistoryEntry[]>([]);
  const [isHistoryClearing, setIsHistoryClearing] = useState(false);
  const [historyColumnHeight, setHistoryColumnHeight] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const clipboardPollRef = useRef<number | null>(null);
  const liveMirrorTimerRef = useRef<number | null>(null);
  const lastClipboardRef = useRef("");
  const skipBroadcastUntilRef = useRef(0);
  const clientIdRef = useRef("");
  const clientNameRef = useRef("");
  const deviceIpRef = useRef("");
  const accessTokenRef = useRef("");
  const lastUserEditAtRef = useRef(0);
  const lastTimestampByClientRef = useRef(new Map<string, number>());
  const manualLockRef = useRef(false);
  const connectAttemptRef = useRef(0);
  const scratchpadCardRef = useRef<HTMLDivElement | null>(null);

  const wsUrl = useMemo(() => {
    const effectiveAccessToken = authRequired ? accessToken : "";
    return resolveWebSocketUrl({ wsPort, wsPublicPath, wsPublicUrl, accessToken: effectiveAccessToken });
  }, [accessToken, authRequired, wsPort, wsPublicPath, wsPublicUrl]);

  const wsCandidates = useMemo(() => {
    const effectiveAccessToken = authRequired ? accessToken : "";
    return buildWebSocketCandidates({ wsPort, wsPublicPath, wsPublicUrl, accessToken: effectiveAccessToken });
  }, [accessToken, authRequired, wsPort, wsPublicPath, wsPublicUrl]);

  const [activeWsUrl, setActiveWsUrl] = useState("");

  const sendClipboard = useCallback((text: string, options?: { persistToHistory?: boolean }) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    const payload: ClipboardUpdateMessage = {
      type: "clipboard_update",
      text,
      clientId: clientIdRef.current,
      timestamp: Date.now(),
      persistToHistory: options?.persistToHistory
    };
    ws.send(JSON.stringify(payload));
    setLocalMessagesSent((value) => value + 1);
    return true;
  }, []);

  const sendClientHello = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !clientIdRef.current || !clientNameRef.current) {
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

  const persistAccessToken = useCallback((token: string, pinValue?: string) => {
    const cleanedToken = token.trim();
    const cleanedPin = pinValue?.trim() ?? "";

    accessTokenRef.current = cleanedToken;
    setAccessToken(cleanedToken);
    setAuthGateLocked(authRequired && !cleanedToken);

    if (typeof window !== "undefined") {
      if (cleanedToken) {
        window.sessionStorage.setItem("quickRelayAccessToken", cleanedToken);
        if (pinValue !== undefined) {
          if (cleanedPin) {
            window.sessionStorage.setItem("quickRelayAccessPin", cleanedPin);
          } else {
            window.sessionStorage.removeItem("quickRelayAccessPin");
          }
        }
      } else {
        window.sessionStorage.removeItem("quickRelayAccessToken");
        window.sessionStorage.removeItem("quickRelayAccessPin");
        window.localStorage.removeItem("quickRelayAccessToken");
      }
    }
  }, [authRequired]);

  const exchangeAccessPinForToken = useCallback(async (pinCandidate: string) => {
    if (!authRequired) {
      setAuthError("");
      persistAccessToken("", "");
      return true;
    }

    const cleanedPin = pinCandidate.trim();
    if (!cleanedPin) {
      setAuthError("Enter ACCESS_PIN to continue.");
      setAuthGateLocked(true);
      setStatusText("ACCESS_PIN required before this client can join sync.");
      return false;
    }

    const previousToken = accessTokenRef.current.trim();
    setIsAuthSubmitting(true);
    setAuthError("");

    try {
      const issued = await requestAccessTokenFromPin(cleanedPin);
      persistAccessToken(issued.token, cleanedPin);
      setAccessPinInput(cleanedPin);
      setAuthGateLocked(false);
      setStatusText("Access PIN accepted. Connecting to QuickRelay...");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid access PIN.";
      if (!previousToken) {
        persistAccessToken("", "");
        setAuthGateLocked(true);
      } else {
        setAuthGateLocked(false);
      }
      setAuthError(message);
      setStatusText(message);
      return false;
    } finally {
      setIsAuthSubmitting(false);
    }
  }, [authRequired, persistAccessToken]);

  const writeClipboardText = useCallback(async (text: string) => {
    if (!navigator.clipboard?.writeText) {
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }, []);

  const handleScratchpadChange = useCallback((value: string) => {
    setClipboardText(value);
    lastClipboardRef.current = value;
    skipBroadcastUntilRef.current = 0;
    lastUserEditAtRef.current = Date.now();
    if (liveMirrorTimerRef.current !== null) {
      window.clearTimeout(liveMirrorTimerRef.current);
    }
    liveMirrorTimerRef.current = window.setTimeout(() => {
      sendClipboard(value, { persistToHistory: false });
    }, 140);
    setStatusText("Scratchpad is mirroring live. Use Share + Save when you want to add a history entry.");
  }, [sendClipboard]);

  const handleShareScratchpad = useCallback(async () => {
    const value = normalizeClipboardText(clipboardText);
    if (!value.trim()) {
      setStatusText("Add some text to the scratchpad before sharing it.");
      return;
    }

    const latestSavedEntry = historyEntries[0];
    if (latestSavedEntry && normalizeClipboardText(latestSavedEntry.text) === value) {
      setStatusText("Scratchpad already matches the latest saved history entry.");
      return;
    }

    if (liveMirrorTimerRef.current !== null) {
      window.clearTimeout(liveMirrorTimerRef.current);
      liveMirrorTimerRef.current = null;
    }

    lastClipboardRef.current = value;
    skipBroadcastUntilRef.current = 0;
    lastUserEditAtRef.current = Date.now();

    const copied = await writeClipboardText(value);
    const sent = sendClipboard(value, { persistToHistory: true });

    setStatusText(
      sent
        ? copied
          ? "Scratchpad shared and saved to history."
          : "Scratchpad shared and saved, but clipboard write is blocked locally."
        : "Scratchpad updated locally. Connect to sync and save it to history."
    );
  }, [clipboardText, historyEntries, sendClipboard, writeClipboardText]);

  const handleReuseHistoryItem = useCallback(async (entry: ClipboardHistoryEntry) => {
    setClipboardText(entry.text);
    lastClipboardRef.current = entry.text;
    skipBroadcastUntilRef.current = 0;
    lastUserEditAtRef.current = Date.now();
    const copied = await writeClipboardText(entry.text);
    setStatusText(
      copied
        ? "History entry restored to the scratchpad. Share it when you're ready to save a fresh entry."
        : "History entry restored locally. Share it when you're ready to save a fresh entry."
    );
  }, [writeClipboardText]);

  const handleCopyHistoryItem = useCallback(async (entry: ClipboardHistoryEntry) => {
    lastClipboardRef.current = entry.text;
    lastUserEditAtRef.current = Date.now();
    const copied = await writeClipboardText(entry.text);
    setStatusText(copied ? "History entry copied to the local clipboard." : "Clipboard write is blocked on this page.");
  }, [writeClipboardText]);

  const handleClearHistory = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setStatusText("Connect to the sync server before clearing shared history.");
      return;
    }
    setIsHistoryClearing(true);
    ws.send(JSON.stringify({ type: "history_clear" }));
  }, []);

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

    const storedAccessToken = window.sessionStorage.getItem("quickRelayAccessToken") ?? "";
    const storedAccessPin = window.sessionStorage.getItem("quickRelayAccessPin") ?? "";
    const resolvedAccessToken = authRequired ? storedAccessToken.trim() : "";
    const resolvedAccessPin = authRequired ? storedAccessPin.trim() : "";

    accessTokenRef.current = resolvedAccessToken;
    setAccessToken(resolvedAccessToken);
    setAccessPinInput(resolvedAccessPin);

    const requiresPin = authRequired && !resolvedAccessToken;
    setAuthGateLocked(requiresPin);
    if (requiresPin) {
      setStatusText("Session locked. Enter ACCESS_PIN to continue.");
    }

    if (!authRequired) {
      window.sessionStorage.removeItem("quickRelayAccessToken");
      window.sessionStorage.removeItem("quickRelayAccessPin");
      window.localStorage.removeItem("quickRelayAccessToken");
      setAccessPinInput("");
    }

    window.localStorage.removeItem("quickRelayAccessToken");

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
    setAuthError("");
    setIsAuthSubmitting(false);
    setAccessPinInput("");
    persistAccessToken("", "");
  }, [authRequired, persistAccessToken]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const scratchpadCard = scratchpadCardRef.current;
    if (!scratchpadCard) {
      return;
    }

    const desktopMediaQuery = window.matchMedia("(min-width: 1280px)");
    let animationFrame = 0;

    const syncHistoryHeight = () => {
      if (!desktopMediaQuery.matches) {
        setHistoryColumnHeight(null);
        return;
      }

      const nextHeight = Math.round(scratchpadCard.getBoundingClientRect().height);
      setHistoryColumnHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
    };

    const scheduleSync = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(syncHistoryHeight);
    };

    const resizeObserver = new ResizeObserver(scheduleSync);
    resizeObserver.observe(scratchpadCard);

    const handleViewportChange = () => scheduleSync();

    scheduleSync();
    window.addEventListener("resize", handleViewportChange);
    if (typeof desktopMediaQuery.addEventListener === "function") {
      desktopMediaQuery.addEventListener("change", handleViewportChange);
    } else {
      desktopMediaQuery.addListener(handleViewportChange);
    }

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleViewportChange);
      if (typeof desktopMediaQuery.removeEventListener === "function") {
        desktopMediaQuery.removeEventListener("change", handleViewportChange);
      } else {
        desktopMediaQuery.removeListener(handleViewportChange);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (liveMirrorTimerRef.current !== null) {
        window.clearTimeout(liveMirrorTimerRef.current);
      }
    };
  }, []);

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
      const clipboardRead = await navigator.permissions.query({ name: "clipboard-read" as PermissionName });
      const clipboardWrite = await navigator.permissions.query({ name: "clipboard-write" as PermissionName });
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

  const applyRemoteClipboard = useCallback(async (incomingText: string, timestamp: number, sourceClientId: string) => {
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
  }, []);

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
      if (text === lastClipboardRef.current || (text === "" && lastClipboardRef.current !== "")) {
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
            setClusterConnectedClients(typeof payload.connectedClients === "number" ? payload.connectedClients : 0);
            setClusterMessagesSeen(typeof payload.totalMessages === "number" ? payload.totalMessages : 0);
            setConnectedClients(Array.isArray(payload.clients) ? (payload.clients as ClusterClient[]) : []);
            const incomingLocal = payload.localNode as Partial<ClusterLocalNode> | undefined;
            if (
              incomingLocal &&
              typeof incomingLocal.displayAddress === "string" &&
              Array.isArray(incomingLocal.addresses) &&
              typeof incomingLocal.wsPort === "number"
            ) {
              setLocalNode({
                displayAddress: incomingLocal.displayAddress,
                addresses: incomingLocal.addresses.filter((value): value is string => typeof value === "string"),
                wsPort: incomingLocal.wsPort,
                online: true
              });
            }
            if (typeof payload.lastClipboardTimestamp === "number") {
              setLastRemoteUpdate(new Date(payload.lastClipboardTimestamp).toLocaleTimeString());
            }
            return;
          }

          if (payload.type === "history_snapshot" && Array.isArray(payload.entries)) {
            setHistoryEntries(
              payload.entries.filter(
                (entry): entry is ClipboardHistoryEntry =>
                  typeof entry?.id === "string" &&
                  typeof entry?.text === "string" &&
                  typeof entry?.createdAt === "number" &&
                  typeof entry?.sourceClientId === "string"
              )
            );
            setIsHistoryClearing(false);
            return;
          }

          if (payload.type === "history_append" && payload.entry) {
            const entry = payload.entry as ClipboardHistoryEntry;
            if (
              typeof entry.id === "string" &&
              typeof entry.text === "string" &&
              typeof entry.createdAt === "number" &&
              typeof entry.sourceClientId === "string"
            ) {
              setHistoryEntries((current) => {
                if (current.some((existing) => existing.id === entry.id)) {
                  return current;
                }
                return [entry, ...current].slice(0, maxHistoryItems);
              });
            }
            return;
          }

          if (payload.type === "history_clear") {
            setHistoryEntries([]);
            setIsHistoryClearing(false);
            setStatusText("Shared history cleared for this server.");
            return;
          }

          if (payload.type === "history_truncate" && Array.isArray(payload.removedIds)) {
            const removedIds = new Set(payload.removedIds.filter((value): value is string => typeof value === "string"));
            if (removedIds.size > 0) {
              setHistoryEntries((current) => current.filter((entry) => !removedIds.has(entry.id)));
            }
            return;
          }

          if (payload.type !== "clipboard_update" || typeof payload.text !== "string") {
            return;
          }
          if (payload.clientId === clientIdRef.current || payload.text === lastClipboardRef.current) {
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
        if (manualLockRef.current) {
          manualLockRef.current = false;
          setIsConnected(false);
          setStatusText("Session locked. Enter ACCESS_PIN to continue.");
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
  }, [applyRemoteClipboard, authRequired, maxHistoryItems, pollLocalClipboard, refreshPermissionState, sendClientHello, wsCandidates]);

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

  const handleSaveClientName = useCallback(async () => {
    if (typeof window === "undefined") {
      return;
    }
    const resolved = clientName.replace(/\s+/g, " ").trim().slice(0, 48) || makeDefaultClientName();
    const cleanedIp = deviceIp.trim();

    if (cleanedIp && !isValidClientIp(cleanedIp)) {
      setStatusText("Device IP must be a valid IPv4 address.");
      return;
    }

    if (authRequired && !accessTokenRef.current.trim()) {
      setAuthGateLocked(true);
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
    setStatusText("Client identity updated.");
  }, [authRequired, clientName, deviceIp, sendClientHello]);

  const handlePinDialogSubmit = useCallback(async () => {
    await exchangeAccessPinForToken(accessPinInput);
  }, [accessPinInput, exchangeAccessPinForToken]);

  const handleLockSession = useCallback(() => {
    setAuthError("");
    setIsAuthSubmitting(false);
    setShowAccessPin(false);
    setAccessPinInput("");
    persistAccessToken("", "");
    setAuthGateLocked(true);
    setStatusText("Session locked. Enter ACCESS_PIN to continue.");
    manualLockRef.current = true;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;
    setIsConnected(false);
  }, [persistAccessToken]);

  const permissionBadgeVariant = permissionLevel === "granted" ? "success" : permissionLevel === "blocked" ? "warning" : "outline";
  const connectionBadgeVariant = isConnected ? "success" : "warning";
  const accessBadgeVariant = !authRequired ? "outline" : authGateLocked ? "warning" : "success";
  const isAuthLocked = authRequired && authGateLocked;
  const pageReady = !isAuthLocked;
  const displayStatus = sanitizeWsUrlForDisplay(activeWsUrl || wsUrl || `ws://<host>:${wsPort}`);
  const surfaceInputClassName =
    "h-12 rounded-2xl border border-border/70 bg-background/80 px-4 text-sm text-foreground shadow-sm transition placeholder:text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-muted/50 disabled:text-muted-foreground/80 disabled:opacity-100";
  const pinFieldClassName = `${surfaceInputClassName} w-full pr-11`;

  useEffect(() => {
    setThemeMode(getInitialThemeMode());
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    document.documentElement.classList.toggle("dark", themeMode === "dark");
    document.documentElement.style.colorScheme = themeMode;
    if (typeof window !== "undefined") {
      window.localStorage.setItem("quickRelayThemeMode", themeMode);
    }
  }, [themeMode]);

  const toggleThemeMode = useCallback(() => {
    setThemeMode((value) => (value === "dark" ? "light" : "dark"));
  }, []);

  return (
    <main className="quickrelay-page relative min-h-screen overflow-hidden px-4 py-3 sm:px-6 sm:py-5 lg:px-8">
      {isAuthLocked ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-md">
          <div className="w-full max-w-md rounded-[32px] border border-border/70 bg-card/95 p-6 shadow-[0_28px_70px_rgba(15,23,42,0.25)] sm:p-7">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <div className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-sm">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <rect x="5" y="11" width="14" height="9" rx="2" />
                    <path d="M8 11V8a4 4 0 118 0v3" />
                  </svg>
                </div>
                <h2 className="mt-4 text-2xl font-semibold tracking-tight text-card-foreground">Unlock QuickRelay</h2>
              </div>
              <Button type="button" variant="outline" size="sm" className="px-3" onClick={toggleThemeMode}>
                {themeMode === "dark" ? "Light" : "Dark"}
              </Button>
            </div>
            <p className="text-sm leading-6 text-muted-foreground">
              This server requires an ACCESS_PIN before this client can join realtime sync.
            </p>
            <form
              className="mt-6 space-y-4"
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
                    className={pinFieldClassName}
                    placeholder="Enter ACCESS_PIN"
                  />
                  <button
                    type="button"
                    onClick={() => setShowAccessPin((value) => !value)}
                    className="absolute right-3 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
                    aria-label={showAccessPin ? "Hide PIN" : "Show PIN"}
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
                        <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8S2 12 2 12z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
              </label>
              {authError ? <p className="text-xs text-warning">{authError}</p> : null}
              <div className="flex justify-end gap-2 pt-1">
                <Button type="submit" className="min-w-[132px]" disabled={isAuthSubmitting}>
                  {isAuthSubmitting ? "Checking..." : "Continue"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      <section className={`quickrelay-shell mx-auto flex w-full max-w-[1780px] flex-col gap-4 ${!pageReady ? "pointer-events-none select-none opacity-60" : ""}`}>
        <div className="quickrelay-hero flex flex-col gap-3 rounded-[26px] border border-border/60 bg-card/75 p-4 shadow-[0_18px_42px_rgba(15,23,42,0.08)] backdrop-blur-xl sm:p-5 lg:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-3">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-sm">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <path d="M7 7h6a4 4 0 014 4v6" />
                    <path d="M17 17h-6a4 4 0 01-4-4V7" />
                    <path d="M8 16L16 8" />
                  </svg>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-primary/80">Realtime scratchpad relay</p>
                  <h1 className="quickrelay-hero-title text-[1.95rem] font-semibold tracking-tight text-foreground sm:text-[2.35rem]">QuickRelay</h1>
                </div>
              </div>
              <p className="quickrelay-hero-copy max-w-[58rem] text-sm leading-7 text-muted-foreground">
                Keep the live scratchpad in front of you while QuickRelay automatically builds a reusable history across the LAN.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 lg:justify-end">
              <Button type="button" variant="outline" size="sm" className="min-w-[112px]" onClick={toggleThemeMode}>
                {themeMode === "dark" ? "Light mode" : "Dark mode"}
              </Button>
              {authRequired && !isAuthLocked ? (
                <Button type="button" variant="secondary" size="sm" className="min-w-[108px]" onClick={handleLockSession}>
                  Lock session
                </Button>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Badge className="px-2.5 py-0.5 text-[10px]" variant={connectionBadgeVariant}>{isConnected ? "Realtime Connected" : "Server Offline"}</Badge>
            <Badge className="px-2.5 py-0.5 text-[10px]" variant={permissionBadgeVariant}>
              {permissionLevel === "granted"
                ? "Clipboard Access Ready"
                : permissionLevel === "checking"
                  ? "Checking Permissions"
                  : permissionLevel === "limited"
                    ? "Permission Prompt Needed"
                    : "Clipboard Access Blocked"}
            </Badge>
            <Badge className="px-2.5 py-0.5 text-[10px]" variant={accessBadgeVariant}>
              {!authRequired ? "No Access PIN" : authGateLocked ? "Access PIN Required" : "Access PIN Accepted"}
            </Badge>
            <Badge className="px-2.5 py-0.5 text-[10px]" variant="outline">{historyEntries.length}/{maxHistoryItems} history slots used</Badge>
          </div>
        </div>

        <div className="quickrelay-workspace grid gap-4 xl:grid-cols-[minmax(0,1.85fr)_330px_330px] xl:items-start">
          <Card ref={scratchpadCardRef} className="quickrelay-panel quickrelay-scratchpad-panel overflow-hidden">
            <CardHeader className="quickrelay-panel-header gap-3 p-5 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <CardTitle className="quickrelay-section-title text-[1.45rem] sm:text-[1.65rem]">Scratchpad</CardTitle>
                  <CardDescription className="quickrelay-section-copy max-w-[30rem] text-sm leading-6">
                    The live text surface stays editable, while history captures the meaningful states you share.
                  </CardDescription>
                </div>
                <div className="quickrelay-live-route rounded-2xl border border-border/70 bg-background/70 px-3.5 py-2.5 text-right shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Live route</p>
                  <p className="mt-1 max-w-[220px] truncate font-mono text-xs text-foreground sm:max-w-[280px]">{displayStatus}</p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="quickrelay-panel-content space-y-3.5 p-5 pt-0 sm:p-5 sm:pt-0">
              <div className="relative">
                <Textarea
                  id="clipboard-mirror"
                  value={clipboardText}
                  placeholder="Paste, type, or restore text here. Use Share + Save when you want to commit a new history entry."
                  onChange={(event) => handleScratchpadChange(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                      event.preventDefault();
                      void handleShareScratchpad();
                    }
                  }}
                  className="quickrelay-scratchpad-input min-h-[230px] pb-16 font-mono text-sm leading-7 sm:min-h-[280px]"
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end p-4">
                  <Button size="sm" onClick={() => void handleShareScratchpad()} className="pointer-events-auto shadow-xl shadow-primary/20">
                    Share + Save
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Tip: press `Ctrl+Enter` or `Cmd+Enter` to share the current scratchpad without leaving the keyboard.
              </p>

              <div className="quickrelay-subpanel rounded-[24px] border border-border/70 bg-background/75 p-3.5 shadow-inner shadow-slate-900/5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-foreground">Connection details</p>
                    <p className="text-xs text-muted-foreground">Current client, route, and server metadata.</p>
                  </div>
                  <div className="inline-flex items-center gap-2 rounded-full bg-muted/70 px-3 py-1.5 text-xs text-muted-foreground">
                    <span className={`h-2.5 w-2.5 rounded-full ${isConnected ? "bg-success" : "bg-warning"}`} />
                    {isConnected ? "Online" : "Retrying"}
                  </div>
                </div>
                <div className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-2">
                  <div className="rounded-2xl border border-border/60 bg-card/80 p-3"><p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/80">Status</p><p className="mt-2 font-mono text-foreground">{statusText}</p></div>
                  <div className="rounded-2xl border border-border/60 bg-card/80 p-3"><p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/80">Server IP</p><p className="mt-2 font-mono text-foreground">{localNode ? `${localNode.displayAddress}:${localNode.wsPort}` : "initializing..."}</p></div>
                  <div className="rounded-2xl border border-border/60 bg-card/80 p-3"><p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/80">This device IP</p><p className="mt-2 font-mono text-foreground">{deviceIp || "unavailable"}</p></div>
                  <div className="rounded-2xl border border-border/60 bg-card/80 p-3"><p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/80">Client name</p><p className="mt-2 font-mono text-foreground">{clientName || "initializing..."}</p></div>
                  <div className="rounded-2xl border border-border/60 bg-card/80 p-3"><p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/80">Cluster server id</p><p className="mt-2 break-all font-mono text-foreground">{clusterServerId ?? "initializing..."}</p></div>
                  <div className="rounded-2xl border border-border/60 bg-card/80 p-3"><p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/80">Local client id</p><p className="mt-2 break-all font-mono text-foreground">{clientId || "initializing..."}</p></div>
                </div>
              </div>

              <div className="quickrelay-subpanel rounded-[24px] border border-border/70 bg-background/75 p-3.5 shadow-inner shadow-slate-900/5">
                <div className="mb-4">
                  <p className="text-sm font-semibold text-foreground">Client identity</p>
                  <p className="text-xs text-muted-foreground">Label this device and manage the optional access PIN for this session.</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-2 text-xs font-medium text-muted-foreground">Client label<input value={clientName} onChange={(event) => setClientName(event.target.value)} className={surfaceInputClassName} placeholder="Set a client name" /></label>
                  <label className="flex flex-col gap-2 text-xs font-medium text-muted-foreground">Device IP (optional)<input value={deviceIp} onChange={(event) => setDeviceIp(event.target.value)} className={surfaceInputClassName} placeholder="e.g. 10.50.100.13" /></label>
                  <label className="flex flex-col gap-2 text-xs font-medium text-muted-foreground md:col-span-2">
                    Access PIN (optional)
                    <div className="relative">
                      <input
                        type={showAccessPin ? "text" : "password"}
                        autoComplete="current-password"
                        value={authRequired ? accessPinInput : ""}
                        readOnly
                        disabled={!authRequired}
                        className={pinFieldClassName}
                        placeholder={authRequired ? "Stored for this browser session" : ""}
                      />
                      {authRequired ? (
                        <button
                          type="button"
                          onClick={() => setShowAccessPin((value) => !value)}
                          className="absolute right-3 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-muted/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                          aria-label={showAccessPin ? "Hide PIN" : "Show PIN"}
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
                              <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8S2 12 2 12z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          )}
                        </button>
                      ) : null}
                    </div>
                  </label>
                </div>
                <div className="mt-4">
                  <p className="text-xs text-muted-foreground">Changes here update how this client appears across the QuickRelay server.</p>
                </div>
              </div>
            </CardContent>
            <CardFooter className="quickrelay-panel-footer flex flex-col gap-2.5 p-5 pt-0 sm:flex-row sm:flex-wrap sm:p-5 sm:pt-0">
              <Button size="sm" onClick={() => void handleEnableClipboard()} variant="secondary" className="w-full sm:w-auto">Enable Clipboard Access</Button>
              <Button size="sm" onClick={() => void pollLocalClipboard()} variant="outline" className="w-full sm:w-auto">Force Read Clipboard</Button>
              <Button size="sm" onClick={() => void handleSaveClientName()} className="w-full sm:w-auto" disabled={isAuthSubmitting}>Save Client Identity</Button>
            </CardFooter>
          </Card>

          <Card
            className="quickrelay-panel quickrelay-history-panel flex flex-col overflow-hidden xl:self-start"
            style={historyColumnHeight ? { height: `${historyColumnHeight}px` } : undefined}
          >
              <CardHeader className="quickrelay-panel-header gap-3 p-5 sm:p-5">
                <div className="flex items-start gap-3">
                  <div>
                    <CardTitle className="quickrelay-section-title text-[1.35rem] sm:text-[1.55rem]">History</CardTitle>
                    <CardDescription className="quickrelay-section-copy text-sm leading-6">Shared entries are stored on the server and survive restarts for this QuickRelay node.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="quickrelay-panel-content flex min-h-0 flex-1 flex-col space-y-3 overflow-hidden p-5 pt-0 sm:p-5 sm:pt-0">
                {historyEntries.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border/70 bg-background/60 p-4 text-sm text-muted-foreground">
                    No history yet. Paste something into the scratchpad or copy text on another connected device to start building the list.
                  </div>
                ) : (
                  <div className="quickrelay-history-list min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 pt-1">
                    {historyEntries.map((entry) => (
                      <button key={entry.id} type="button" onClick={() => void handleReuseHistoryItem(entry)} className="quickrelay-history-item group w-full rounded-[20px] border border-border/70 bg-background/70 p-3.5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/50 hover:bg-background/90">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{formatHistoryTimestamp(entry.createdAt)}</p>
                            <div className="mt-2 line-clamp-5 text-sm leading-7 text-foreground">{renderHistoryMarkdown(entry.text)}</div>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-2">
                            <Button variant="ghost" size="sm" className="text-xs" onClick={(event) => { event.stopPropagation(); void handleCopyHistoryItem(entry); }}>Copy</Button>
                            <span className="text-[11px] text-muted-foreground group-hover:text-primary">Use in scratchpad</span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
              <CardFooter className="quickrelay-panel-footer quickrelay-history-footer justify-center p-5 pt-0 sm:p-5 sm:pt-0">
                <Button
                  size="sm"
                  className="shadow-xl shadow-primary/20"
                  disabled={historyEntries.length === 0 || isHistoryClearing}
                  onClick={handleClearHistory}
                >
                  {isHistoryClearing ? "Clearing..." : "Clear all"}
                </Button>
              </CardFooter>
          </Card>

          <Card className="quickrelay-panel quickrelay-stats-panel xl:self-start">
              <CardHeader className="quickrelay-panel-header p-5 sm:p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="quickrelay-section-title text-[1.35rem] sm:text-[1.55rem]">Session Stats</CardTitle>
                    <CardDescription className="quickrelay-section-copy text-sm leading-6">Live health for this server and connected clients.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="quickrelay-panel-content space-y-3.5 p-5 pt-0 text-sm sm:p-5 sm:pt-0">
                <div className="quickrelay-stat-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                  <div className="rounded-2xl border border-border/70 bg-background/70 p-4 shadow-sm"><p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Local messages sent</p><p className="mt-3 font-mono text-2xl font-semibold text-foreground">{localMessagesSent}</p></div>
                  <div className="rounded-2xl border border-border/70 bg-background/70 p-4 shadow-sm"><p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Cluster messages seen</p><p className="mt-3 font-mono text-2xl font-semibold text-foreground">{clusterMessagesSeen}</p></div>
                  <div className="rounded-2xl border border-border/70 bg-background/70 p-4 shadow-sm"><p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Clients on this server</p><p className="mt-3 font-mono text-2xl font-semibold text-foreground">{clusterConnectedClients}</p></div>
                  <div className="rounded-2xl border border-border/70 bg-background/70 p-4 shadow-sm"><p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">History entries</p><p className="mt-3 font-mono text-2xl font-semibold text-foreground">{historyEntries.length}</p></div>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background/70 p-4 shadow-sm"><p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Last remote update</p><p className="mt-3 font-mono text-base font-semibold text-foreground">{lastRemoteUpdate ?? "None yet"}</p></div>
                <Separator />
                <div className="space-y-3">
                  <p className="text-sm font-semibold text-foreground">Connected clients</p>
                  {connectedClients.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-border/70 bg-background/60 p-4 text-sm text-muted-foreground">No connected clients yet.</div>
                  ) : (
                    <ul className="space-y-3">
                      {connectedClients.map((entry) => (
                        <li key={`${entry.clientId}-${entry.ip}-${entry.connectedAt}`} className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/70 p-4 shadow-sm">
                          <span className="min-w-0">
                            <span className="inline-flex items-center gap-2 font-mono text-sm text-foreground">
                              <span className="inline-block h-2.5 w-2.5 rounded-full bg-success shadow-[0_0_0_4px_rgba(14,165,233,0.1)]" />
                              <span className="truncate">{entry.clientName}</span>
                            </span>
                            <span className="mt-1 block text-xs text-muted-foreground">{entry.clientId === clientId ? "This browser session" : "Connected device"}</span>
                          </span>
                          <span className="shrink-0 text-right text-xs font-medium text-success">{entry.ip}{entry.clientId === clientId ? " (you)" : ""}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}
