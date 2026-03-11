import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type WsAccessTokenAudience = "client" | "peer";

type WsAccessTokenPayload = {
  v: 1;
  scope: "ws";
  aud: WsAccessTokenAudience;
  iat: number;
  exp: number;
  jti: string;
};

const DEFAULT_CLIENT_TOKEN_TTL_MS = 1000 * 60 * 60 * 12;
const DEFAULT_PEER_TOKEN_TTL_MS = 1000 * 60;

function toBase64Url(raw: string | Buffer) {
  return Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(raw: string) {
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = normalized.length % 4;
  const padded = padLength === 0 ? normalized : `${normalized}${"=".repeat(4 - padLength)}`;
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}

function signPayload(payloadSegment: string, secret: string) {
  const digest = createHmac("sha256", secret).update(payloadSegment).digest();
  return toBase64Url(digest);
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function makePayload(audience: WsAccessTokenAudience, ttlMs: number): WsAccessTokenPayload {
  const now = Date.now();
  return {
    v: 1,
    scope: "ws",
    aud: audience,
    iat: now,
    exp: now + Math.max(5_000, ttlMs),
    jti: typeof randomUUID === "function" ? randomUUID() : `jti-${Math.random().toString(36).slice(2, 10)}`
  };
}

export function issueWsAccessToken(
  secret: string,
  options: { audience?: WsAccessTokenAudience; ttlMs?: number } = {}
) {
  const normalizedSecret = secret.trim();
  if (!normalizedSecret) {
    return "";
  }

  const audience = options.audience ?? "client";
  const ttlMs =
    options.ttlMs ??
    (audience === "peer" ? DEFAULT_PEER_TOKEN_TTL_MS : DEFAULT_CLIENT_TOKEN_TTL_MS);
  const payload = makePayload(audience, ttlMs);
  const payloadSegment = toBase64Url(JSON.stringify(payload));
  const signatureSegment = signPayload(payloadSegment, normalizedSecret);
  return `${payloadSegment}.${signatureSegment}`;
}

export function getDefaultClientTokenTtlMs() {
  return DEFAULT_CLIENT_TOKEN_TTL_MS;
}

export function verifyWsAccessToken(
  token: string,
  secret: string,
  expectedAudience?: WsAccessTokenAudience
) {
  const normalizedSecret = secret.trim();
  if (!normalizedSecret) {
    return false;
  }

  const [payloadSegment, signatureSegment, ...rest] = token.trim().split(".");
  if (!payloadSegment || !signatureSegment || rest.length > 0) {
    return false;
  }

  const expectedSignature = signPayload(payloadSegment, normalizedSecret);
  if (!safeEqual(signatureSegment, expectedSignature)) {
    return false;
  }

  const decoded = fromBase64Url(payloadSegment);
  if (!decoded) {
    return false;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decoded.toString("utf8"));
  } catch {
    return false;
  }

  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const parsed = payload as Partial<WsAccessTokenPayload>;
  if (parsed.v !== 1 || parsed.scope !== "ws" || typeof parsed.exp !== "number") {
    return false;
  }

  if (parsed.exp <= Date.now()) {
    return false;
  }

  if (expectedAudience && parsed.aud !== expectedAudience) {
    return false;
  }

  if (parsed.aud !== "client" && parsed.aud !== "peer") {
    return false;
  }

  return true;
}
