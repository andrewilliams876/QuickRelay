import dgram from "node:dgram";
import type { IncomingMessage } from "node:http";
import os from "node:os";

import { WebSocket, WebSocketServer } from "ws";

import { issueWsAccessToken, verifyWsAccessToken } from "./app/lib/access-token.server";

type ClipboardUpdateMessage = {
  type: "clipboard_update";
  text: string;
  clientId: string;
  timestamp: number;
  messageId?: string;
  originServerId?: string;
};

type ClipboardUpdateNormalized = ClipboardUpdateMessage & {
  messageId: string;
  originServerId: string;
};

type PeerHelloMessage = {
  type: "peer_hello";
  serverId: string;
  wsPort?: number;
};

type ClientHelloMessage = {
  type: "client_hello";
  clientId: string;
  clientName: string;
  clientIpHint?: string;
};

type DiscoveryPacket = {
  type: "lan_clipboard_discovery";
  serverId: string;
  wsPort: number;
  timestamp: number;
};

type PeerSnapshot = {
  key: string;
  host: string;
  port: number;
  serverId: string | null;
  online: boolean;
  lastSeen: number | null;
};

type LocalNodeSnapshot = {
  displayAddress: string;
  addresses: string[];
  wsPort: number;
  online: true;
};

type ClientSnapshot = {
  clientId: string;
  clientName: string;
  ip: string;
  connectedAt: number;
  lastSeen: number;
};

type ClusterStateMessage = {
  type: "cluster_state";
  serverId: string;
  connectedClients: number;
  totalMessages: number;
  lastClipboardTimestamp: number | null;
  localNode: LocalNodeSnapshot;
  clients: ClientSnapshot[];
  peers: PeerSnapshot[];
};

type SocketRole = "client" | "peer";

type PeerMeta = {
  key: string;
  host: string;
  port: number;
  serverId: string | null;
  lastSeen: number | null;
  fromSeed: boolean;
  fromDiscovery: boolean;
};

type ClientMeta = {
  clientId: string;
  clientName: string;
  ip: string;
  ipObserved: string;
  connectedAt: number;
  lastSeen: number;
};

const wsPort = Number(process.env.WS_PORT ?? 3001);
const wsHost = process.env.WS_HOST ?? "0.0.0.0";
const discoveryEnabled = process.env.DISCOVERY_ENABLED === "true";
const discoveryPort = Number(process.env.DISCOVERY_PORT ?? 4001);
const discoveryBroadcast = process.env.DISCOVERY_BROADCAST ?? "255.255.255.255";
const discoveryIntervalMs = Number(process.env.DISCOVERY_INTERVAL_MS ?? 3000);
const discoveryPeerTtlMs = Number(process.env.DISCOVERY_PEER_TTL_MS ?? 15000);
const peerReconnectMs = Number(process.env.PEER_RECONNECT_MS ?? 3000);
const seenMessageTtlMs = Number(process.env.SEEN_MESSAGE_TTL_MS ?? 120000);
const clusterStateIntervalMs = Number(process.env.CLUSTER_STATE_INTERVAL_MS ?? 1500);
const serverId = process.env.SERVER_ID ?? makeId();
const accessPin = (process.env.ACCESS_PIN ?? "").trim();
const authRequired = accessPin.length > 0;
const localNodeIpOverride = normalizeAddress((process.env.LOCAL_NODE_IP ?? "").trim()) || null;
const localNodeAddresses = getLocalNodeAddresses(localNodeIpOverride);
const localAddressSet = new Set(localNodeAddresses);
const localNodeAliases = new Set<string>();

const peerSeeds = (process.env.PEER_SEEDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((seed) => {
    const [host, rawPort] = seed.split(":");
    if (!host || !rawPort || Number.isNaN(Number(rawPort))) {
      return null;
    }
    const normalizedHost = normalizeAddress(host);
    const port = Number(rawPort);
    if (isSelfSeed(normalizedHost, port)) {
      return null;
    }
    return { host: normalizedHost, port, key: `${normalizedHost}:${rawPort}` };
  })
  .filter((value): value is { host: string; port: number; key: string } => value !== null);

const inboundSockets = new Set<WebSocket>();
const socketRoles = new Map<WebSocket, SocketRole>();
const peerSocketIds = new Map<WebSocket, string>();
const outboundPeers = new Map<string, WebSocket>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();
const discoveredPeers = new Map<
  string,
  { serverId: string; host: string; port: number; lastSeen: number; key: string }
>();
const peerMetadata = new Map<string, PeerMeta>();
const clientMetadata = new Map<WebSocket, ClientMeta>();
const seenMessages = new Map<string, number>();

for (const seed of peerSeeds) {
  ensurePeerMeta(seed.key, seed.host, seed.port, { fromSeed: true });
}

let latestMessage: ClipboardUpdateNormalized | null = null;
let totalMessages = 0;
let discoverySocket: dgram.Socket | null = null;
let discoveryTimer: NodeJS.Timeout | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;
let clusterStateTimer: NodeJS.Timeout | null = null;

const wsServer = new WebSocketServer({
  host: wsHost,
  port: wsPort,
  verifyClient: (info, done) => {
    if (isAuthorizedWsRequest(info.req)) {
      done(true);
      return;
    }
    done(false, 401, "Unauthorized");
  }
});

function makeId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2, 12)}`;
}

function normalizeAddress(raw: string) {
  if (raw.startsWith("::ffff:")) {
    return raw.slice(7);
  }
  if (raw === "::1") {
    return "127.0.0.1";
  }
  return raw;
}

function sanitizeClientName(raw: string) {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "Unnamed Client";
  }
  return cleaned.slice(0, 48);
}

function isValidIpv4(raw: string) {
  const value = normalizeAddress(raw.trim());
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }
  const octets = match.slice(1).map((part) => Number(part));
  if (octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  if (value === "0.0.0.0" || value.startsWith("127.")) {
    return false;
  }
  return true;
}

function normalizeClientIpHint(raw: unknown) {
  if (typeof raw !== "string") {
    return null;
  }
  const value = normalizeAddress(raw);
  if (!isValidIpv4(value)) {
    return null;
  }
  return value;
}

function getRemoteIp(request: IncomingMessage) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return normalizeAddress(first);
    }
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    const first = forwarded[0]?.split(",")[0]?.trim();
    if (first) {
      return normalizeAddress(first);
    }
  }
  return normalizeAddress(request.socket.remoteAddress ?? "unknown");
}
function isAuthorizedWsRequest(request: IncomingMessage) {
  if (!authRequired) {
    return true;
  }

  const hostHeader = request.headers.host ?? `localhost:${wsPort}`;
  try {
    const url = new URL(request.url ?? "/", `http://${hostHeader}`);
    const token = (url.searchParams.get("token") ?? "").trim();
    return token.length > 0 && verifyWsAccessToken(token, accessPin);
  } catch {
    return false;
  }
}

function isLikelyVirtualOrBridgeAddress(ip: string) {
  if (/^192\.168\.65\./.test(ip)) {
    return true;
  }
  const match = ip.match(/^172\.(\d{1,3})\./);
  if (!match) {
    return false;
  }
  const segment = Number(match[1]);
  return Number.isInteger(segment) && segment >= 16 && segment <= 31;
}

function getLocalNodeAddresses(overrideIp: string | null) {
  const addresses = new Set<string>();
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (entry.family !== "IPv4") {
        continue;
      }
      addresses.add(normalizeAddress(entry.address));
    }
  }
  if (overrideIp) {
    addresses.add(overrideIp);
  }
  if (addresses.size === 0) {
    addresses.add("127.0.0.1");
  }
  return Array.from(addresses).sort();
}

function pickLocalAddress(addresses: string[], overrideIp: string | null) {
  if (overrideIp) {
    return overrideIp;
  }
  const preferred = addresses.find(
    (value) => value !== "127.0.0.1" && !isLikelyVirtualOrBridgeAddress(value)
  );
  if (preferred) {
    return preferred;
  }
  const nonLoopback = addresses.find((value) => value !== "127.0.0.1");
  return nonLoopback ?? addresses[0] ?? "127.0.0.1";
}

function isSelfSeed(host: string, port: number) {
  if (port !== wsPort) {
    return false;
  }
  if (host === "localhost") {
    return true;
  }
  const normalizedHost = normalizeAddress(host);
  if (localNodeIpOverride && normalizedHost === localNodeIpOverride) {
    return true;
  }
  return localAddressSet.has(normalizedHost);
}

function getResolvedLocalAddresses() {
  const addresses = new Set(localNodeAddresses);
  if (localNodeIpOverride) {
    addresses.add(localNodeIpOverride);
  }
  for (const alias of localNodeAliases) {
    addresses.add(alias);
  }
  return Array.from(addresses).sort();
}

function shouldUseAliasAddress(host: string) {
  if (!host || host === "unknown") {
    return false;
  }
  if (localNodeIpOverride) {
    return host === localNodeIpOverride;
  }
  if (localAddressSet.has(host)) {
    return true;
  }
  return !isLikelyVirtualOrBridgeAddress(host);
}

function markPeerAsLocalAlias(host: string, port: number) {
  const normalizedHost = normalizeAddress(host);
  if (!normalizedHost || normalizedHost === "unknown") {
    return;
  }
  if (port === wsPort && shouldUseAliasAddress(normalizedHost)) {
    localNodeAliases.add(normalizedHost);
  }
  const peerKey = `${normalizedHost}:${port}`;
  peerMetadata.delete(peerKey);
  outboundPeers.delete(peerKey);
  clearReconnectTimer(peerKey);
  for (const [remoteServerId, peer] of discoveredPeers) {
    if (peer.key === peerKey) {
      discoveredPeers.delete(remoteServerId);
    }
  }
}

function parseJson(raw: unknown): unknown {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString();
  } else if (Array.isArray(raw)) {
    text = Buffer.concat(raw).toString();
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString();
  } else if (ArrayBuffer.isView(raw)) {
    text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString();
  } else {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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

function isPeerHelloMessage(input: unknown): input is PeerHelloMessage {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const payload = input as Partial<PeerHelloMessage>;
  return payload.type === "peer_hello" && typeof payload.serverId === "string";
}

function isClientHelloMessage(input: unknown): input is ClientHelloMessage {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const payload = input as Partial<ClientHelloMessage>;
  return (
    payload.type === "client_hello" &&
    typeof payload.clientId === "string" &&
    typeof payload.clientName === "string" &&
    (payload.clientIpHint === undefined || typeof payload.clientIpHint === "string")
  );
}

function isDiscoveryPacket(input: unknown): input is DiscoveryPacket {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const payload = input as Partial<DiscoveryPacket>;
  return (
    payload.type === "lan_clipboard_discovery" &&
    typeof payload.serverId === "string" &&
    typeof payload.wsPort === "number" &&
    typeof payload.timestamp === "number"
  );
}

function ensurePeerMeta(
  peerKey: string,
  host: string,
  port: number,
  flags: { fromSeed?: boolean; fromDiscovery?: boolean } = {}
) {
  const existing = peerMetadata.get(peerKey);
  if (!existing) {
    peerMetadata.set(peerKey, {
      key: peerKey,
      host,
      port,
      serverId: null,
      lastSeen: null,
      fromSeed: Boolean(flags.fromSeed),
      fromDiscovery: Boolean(flags.fromDiscovery)
    });
    return;
  }
  existing.host = host;
  existing.port = port;
  existing.fromSeed = existing.fromSeed || Boolean(flags.fromSeed);
  existing.fromDiscovery = existing.fromDiscovery || Boolean(flags.fromDiscovery);
}

function updatePeerMetaFromHello(peerKey: string, remoteServerId: string) {
  const meta = peerMetadata.get(peerKey);
  if (!meta) {
    return;
  }
  meta.serverId = remoteServerId;
  meta.lastSeen = Date.now();
}

function touchPeerByServerId(remoteServerId: string) {
  const now = Date.now();
  for (const meta of peerMetadata.values()) {
    if (meta.serverId === remoteServerId) {
      meta.lastSeen = now;
    }
  }
}

function markSeen(messageId: string) {
  if (seenMessages.has(messageId)) {
    return false;
  }
  seenMessages.set(messageId, Date.now());
  return true;
}

function cleanupCaches() {
  const now = Date.now();

  for (const [messageId, seenAt] of seenMessages) {
    if (now - seenAt > seenMessageTtlMs) {
      seenMessages.delete(messageId);
    }
  }

  for (const [remoteServerId, peer] of discoveredPeers) {
    if (now - peer.lastSeen > discoveryPeerTtlMs * 8) {
      discoveredPeers.delete(remoteServerId);
      const meta = peerMetadata.get(peer.key);
      if (meta && !meta.fromSeed) {
        peerMetadata.delete(peer.key);
      }
    }
  }
}

function normalizeClipboardMessage(message: ClipboardUpdateMessage): ClipboardUpdateNormalized {
  return {
    ...message,
    messageId: message.messageId ?? makeId(),
    originServerId: message.originServerId ?? serverId
  };
}

function sendJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

function getConnectedClientCount() {
  let count = 0;
  for (const [socket] of clientMetadata) {
    if (socket.readyState === WebSocket.OPEN && socketRoles.get(socket) === "client") {
      count += 1;
    }
  }
  return count;
}

function getClientSnapshots(): ClientSnapshot[] {
  const snapshots: ClientSnapshot[] = [];
  for (const [socket, meta] of clientMetadata) {
    if (socketRoles.get(socket) !== "client" || socket.readyState !== WebSocket.OPEN) {
      continue;
    }
    snapshots.push({
      clientId: meta.clientId,
      clientName: meta.clientName,
      ip: meta.ip,
      connectedAt: meta.connectedAt,
      lastSeen: meta.lastSeen
    });
  }
  snapshots.sort((left, right) => {
    const byName = left.clientName.localeCompare(right.clientName);
    if (byName !== 0) {
      return byName;
    }
    return left.ip.localeCompare(right.ip);
  });
  return snapshots;
}

function isPeerMetaOnline(meta: PeerMeta) {
  const outbound = outboundPeers.get(meta.key);
  if (outbound && outbound.readyState === WebSocket.OPEN) {
    return true;
  }
  if (!meta.serverId) {
    return false;
  }
  for (const socket of inboundSockets) {
    if (
      socket.readyState === WebSocket.OPEN &&
      socketRoles.get(socket) === "peer" &&
      peerSocketIds.get(socket) === meta.serverId
    ) {
      return true;
    }
  }
  return false;
}

function inferLikelyLocalAliasFromSeeds() {
  const unresolvedSeedPeers: PeerMeta[] = [];
  let knownRemotePeers = 0;

  for (const meta of peerMetadata.values()) {
    const online = isPeerMetaOnline(meta);
    if (meta.serverId && meta.serverId !== serverId) {
      knownRemotePeers += 1;
    }
    if (meta.fromSeed && meta.port === wsPort && !meta.serverId && !online) {
      unresolvedSeedPeers.push(meta);
    }
  }

  if (knownRemotePeers >= 1 && unresolvedSeedPeers.length === 1) {
    const candidate = unresolvedSeedPeers[0];
    markPeerAsLocalAlias(candidate.host, candidate.port);
  }
}

function getPeerSnapshots(): PeerSnapshot[] {
  const snapshots: PeerSnapshot[] = [];
  for (const meta of peerMetadata.values()) {
    const online = isPeerMetaOnline(meta);
    if (!online && !meta.serverId) {
      continue;
    }

    snapshots.push({
      key: meta.key,
      host: meta.host,
      port: meta.port,
      serverId: meta.serverId,
      online,
      lastSeen: meta.lastSeen
    });
  }

  snapshots.sort((left, right) => left.key.localeCompare(right.key));
  return snapshots;
}

function buildClusterState(): ClusterStateMessage {
  inferLikelyLocalAliasFromSeeds();
  const addresses = getResolvedLocalAddresses();
  const preferredAddresses = [...localNodeAliases, ...localNodeAddresses];
  return {
    type: "cluster_state",
    serverId,
    connectedClients: getConnectedClientCount(),
    totalMessages,
    lastClipboardTimestamp: latestMessage?.timestamp ?? null,
    localNode: {
      displayAddress: pickLocalAddress(preferredAddresses, localNodeIpOverride),
      addresses,
      wsPort,
      online: true
    },
    clients: getClientSnapshots(),
    peers: getPeerSnapshots()
  };
}

function sendClusterStateToClient(socket: WebSocket) {
  if (socketRoles.get(socket) !== "client") {
    return;
  }
  sendJson(socket, buildClusterState());
}

function broadcastClusterState() {
  const state = buildClusterState();
  for (const socket of inboundSockets) {
    if (socketRoles.get(socket) !== "client") {
      continue;
    }
    sendJson(socket, state);
  }
}

function broadcastToLocalClients(message: ClipboardUpdateNormalized, except?: WebSocket) {
  for (const socket of inboundSockets) {
    if (socket === except) {
      continue;
    }
    if (socketRoles.get(socket) !== "client") {
      continue;
    }
    sendJson(socket, message);
  }
}

function getAllPeerSockets() {
  const result = new Set<WebSocket>();
  for (const socket of inboundSockets) {
    if (socketRoles.get(socket) === "peer") {
      result.add(socket);
    }
  }
  for (const socket of outboundPeers.values()) {
    result.add(socket);
  }
  return result;
}

function broadcastToPeerServers(message: ClipboardUpdateNormalized, except?: WebSocket) {
  const peerSockets = getAllPeerSockets();
  for (const socket of peerSockets) {
    if (socket === except) {
      continue;
    }
    sendJson(socket, message);
  }
}

function applyClipboardMessage(message: ClipboardUpdateMessage, sourceSocket?: WebSocket) {
  const normalized = normalizeClipboardMessage(message);
  if (!markSeen(normalized.messageId)) {
    return;
  }

  totalMessages += 1;
  latestMessage = normalized;
  touchPeerByServerId(normalized.originServerId);
  broadcastToLocalClients(normalized, sourceSocket);
  broadcastToPeerServers(normalized, sourceSocket);
  broadcastClusterState();
}

function cleanupSocket(socket: WebSocket) {
  inboundSockets.delete(socket);
  socketRoles.delete(socket);
  peerSocketIds.delete(socket);
  clientMetadata.delete(socket);
  broadcastClusterState();
}

function registerInboundSocketHandlers(socket: WebSocket, request: IncomingMessage) {
  const remoteIp = getRemoteIp(request);
  const connectedAt = Date.now();

  inboundSockets.add(socket);
  socketRoles.set(socket, "client");
  clientMetadata.set(socket, {
    clientId: `anon-${makeId()}`,
    clientName: "Unnamed Client",
    ip: remoteIp,
    ipObserved: remoteIp,
    connectedAt,
    lastSeen: connectedAt
  });

  if (latestMessage) {
    sendJson(socket, latestMessage);
  }
  sendClusterStateToClient(socket);
  broadcastClusterState();

  socket.on("message", (raw) => {
    const parsed = parseJson(raw);
    if (!parsed) {
      return;
    }

    if (isPeerHelloMessage(parsed)) {
      if (parsed.serverId === serverId) {
        const remoteHost = remoteIp;
        const remoteWsPort = typeof parsed.wsPort === "number" ? parsed.wsPort : wsPort;
        markPeerAsLocalAlias(remoteHost, remoteWsPort);
        broadcastClusterState();
        socket.close(1000, "Ignoring self peer");
        return;
      }

      const remoteHost = remoteIp;
      const remoteWsPort = typeof parsed.wsPort === "number" ? parsed.wsPort : wsPort;
      const peerKey = `${remoteHost}:${remoteWsPort}`;
      ensurePeerMeta(peerKey, remoteHost, remoteWsPort);
      updatePeerMetaFromHello(peerKey, parsed.serverId);

      discoveredPeers.set(parsed.serverId, {
        serverId: parsed.serverId,
        host: remoteHost,
        port: remoteWsPort,
        lastSeen: Date.now(),
        key: peerKey
      });

      socketRoles.set(socket, "peer");
      clientMetadata.delete(socket);
      peerSocketIds.set(socket, parsed.serverId);
      sendJson(socket, { type: "peer_hello", serverId, wsPort } satisfies PeerHelloMessage);
      if (latestMessage) {
        sendJson(socket, latestMessage);
      }
      broadcastClusterState();
      return;
    }

    if (isClientHelloMessage(parsed)) {
      if (socketRoles.get(socket) !== "client") {
        return;
      }
      const existing = clientMetadata.get(socket);
      if (!existing) {
        return;
      }
      existing.clientId = parsed.clientId;
      existing.clientName = sanitizeClientName(parsed.clientName);
      const hintedIp = normalizeClientIpHint(parsed.clientIpHint);
      existing.ip = hintedIp ?? existing.ipObserved;
      existing.lastSeen = Date.now();
      broadcastClusterState();
      return;
    }

    if (!isClipboardUpdateMessage(parsed)) {
      return;
    }

    const existing = clientMetadata.get(socket);
    if (existing) {
      existing.clientId = parsed.clientId || existing.clientId;
      existing.ip = normalizeClientIpHint((parsed as { clientIpHint?: unknown }).clientIpHint) ?? existing.ip;
      existing.lastSeen = Date.now();
    }

    if (parsed.originServerId) {
      touchPeerByServerId(parsed.originServerId);
    }
    applyClipboardMessage(parsed, socket);
  });

  socket.on("close", () => {
    cleanupSocket(socket);
  });

  socket.on("error", () => {
    cleanupSocket(socket);
  });
}


function buildPeerWebSocketUrl(host: string, port: number) {
  const url = new URL(`ws://${host}:${port}`);
  if (authRequired) {
    const peerToken = issueWsAccessToken(accessPin, { audience: "peer" });
    if (peerToken) {
      url.searchParams.set("token", peerToken);
    }
  }
  return url.toString();
}
function clearReconnectTimer(peerKey: string) {
  const timer = reconnectTimers.get(peerKey);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  reconnectTimers.delete(peerKey);
}

function shouldReconnectPeer(peerKey: string) {
  if (peerSeeds.some((seed) => seed.key === peerKey)) {
    return true;
  }
  const now = Date.now();
  for (const peer of discoveredPeers.values()) {
    if (peer.key === peerKey && now - peer.lastSeen < discoveryPeerTtlMs) {
      return true;
    }
  }
  return false;
}

function schedulePeerReconnect(host: string, port: number, peerKey: string) {
  if (reconnectTimers.has(peerKey)) {
    return;
  }
  const timer = setTimeout(() => {
    reconnectTimers.delete(peerKey);
    if (!shouldReconnectPeer(peerKey)) {
      return;
    }
    connectToPeer(host, port, peerKey);
  }, peerReconnectMs);
  reconnectTimers.set(peerKey, timer);
}

function connectToPeer(host: string, port: number, peerKey: string) {
  ensurePeerMeta(peerKey, host, port);

  const existing = outboundPeers.get(peerKey);
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearReconnectTimer(peerKey);

  const socket = new WebSocket(buildPeerWebSocketUrl(host, port));
  outboundPeers.set(peerKey, socket);

  socket.on("open", () => {
    console.log(`[quickrelay] Connected peer ${peerKey}`);
    sendJson(socket, { type: "peer_hello", serverId, wsPort } satisfies PeerHelloMessage);
    if (latestMessage) {
      sendJson(socket, latestMessage);
    }
    broadcastClusterState();
  });

  socket.on("message", (raw) => {
    const parsed = parseJson(raw);
    if (!parsed) {
      return;
    }

    if (isPeerHelloMessage(parsed)) {
      if (parsed.serverId === serverId) {
        markPeerAsLocalAlias(host, port);
        broadcastClusterState();
        socket.close(1000, "Ignoring self peer");
        return;
      }
      updatePeerMetaFromHello(peerKey, parsed.serverId);
      discoveredPeers.set(parsed.serverId, {
        serverId: parsed.serverId,
        host,
        port,
        lastSeen: Date.now(),
        key: peerKey
      });
      broadcastClusterState();
      return;
    }

    if (!isClipboardUpdateMessage(parsed)) {
      return;
    }

    if (parsed.originServerId) {
      touchPeerByServerId(parsed.originServerId);
    }
    applyClipboardMessage(parsed, socket);
  });

  socket.on("close", () => {
    console.log(`[quickrelay] Peer closed ${peerKey}`);
    if (outboundPeers.get(peerKey) === socket) {
      outboundPeers.delete(peerKey);
    }
    schedulePeerReconnect(host, port, peerKey);
    broadcastClusterState();
  });

  socket.on("error", () => {
    console.log(`[quickrelay] Peer error ${peerKey}`);
    if (outboundPeers.get(peerKey) === socket) {
      outboundPeers.delete(peerKey);
    }
    schedulePeerReconnect(host, port, peerKey);
    broadcastClusterState();
  });
}

function sendDiscoveryHeartbeat() {
  if (!discoverySocket) {
    return;
  }
  const packet: DiscoveryPacket = {
    type: "lan_clipboard_discovery",
    serverId,
    wsPort,
    timestamp: Date.now()
  };
  const raw = Buffer.from(JSON.stringify(packet));
  discoverySocket.send(raw, discoveryPort, discoveryBroadcast);
}

function setupDiscovery() {
  if (!discoveryEnabled) {
    console.log("[quickrelay] Discovery disabled.");
    return;
  }

  discoverySocket = dgram.createSocket("udp4");

  discoverySocket.on("error", (error) => {
    console.error("[quickrelay] UDP discovery error:", error);
  });

  discoverySocket.on("message", (raw, remote) => {
    const parsed = parseJson(raw);
    if (!parsed || !isDiscoveryPacket(parsed)) {
      return;
    }
    if (parsed.serverId === serverId) {
      return;
    }

    const host = normalizeAddress(remote.address);
    const peerKey = `${host}:${parsed.wsPort}`;
    discoveredPeers.set(parsed.serverId, {
      serverId: parsed.serverId,
      host,
      port: parsed.wsPort,
      lastSeen: Date.now(),
      key: peerKey
    });
    ensurePeerMeta(peerKey, host, parsed.wsPort, { fromDiscovery: true });
    updatePeerMetaFromHello(peerKey, parsed.serverId);

    console.log(`[quickrelay] Discovered peer ${parsed.serverId} at ${peerKey}`);
    connectToPeer(host, parsed.wsPort, peerKey);
    broadcastClusterState();
  });

  discoverySocket.bind(discoveryPort, "0.0.0.0", () => {
    discoverySocket?.setBroadcast(true);
    console.log(
      `[quickrelay] Discovery enabled on udp://${discoveryBroadcast}:${discoveryPort} (server ${serverId})`
    );
    sendDiscoveryHeartbeat();
    discoveryTimer = setInterval(sendDiscoveryHeartbeat, discoveryIntervalMs);
  });
}

wsServer.on("connection", registerInboundSocketHandlers);

wsServer.on("listening", () => {
  console.log(`[quickrelay] WebSocket server listening on ws://${wsHost}:${wsPort} (server ${serverId})`);
});

wsServer.on("error", (error) => {
  console.error("[quickrelay] WebSocket server error:", error);
});

for (const seed of peerSeeds) {
  connectToPeer(seed.host, seed.port, seed.key);
}

setupDiscovery();
cleanupTimer = setInterval(cleanupCaches, 30_000);
clusterStateTimer = setInterval(broadcastClusterState, clusterStateIntervalMs);

const shutdown = () => {
  console.log("[quickrelay] Shutting down...");

  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  if (clusterStateTimer) {
    clearInterval(clusterStateTimer);
    clusterStateTimer = null;
  }

  for (const timer of reconnectTimers.values()) {
    clearTimeout(timer);
  }
  reconnectTimers.clear();

  for (const socket of inboundSockets) {
    socket.close(1001, "Server shutting down");
  }
  for (const socket of outboundPeers.values()) {
    socket.close(1001, "Server shutting down");
  }
  outboundPeers.clear();

  discoverySocket?.close();
  discoverySocket = null;

  wsServer.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

