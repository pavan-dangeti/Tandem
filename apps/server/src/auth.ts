import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as jose from "jose";
import bcrypt from "bcryptjs";

// A known fallback would let anyone mint sessions and share links, so production
// refuses to start without real secrets.
function secret(name: "AUTH_SECRET" | "SHARE_SECRET"): string {
  const v = process.env[name];
  if (v && v.length >= 32) return v;
  if (process.env.NODE_ENV === "production")
    throw new Error(`${name} must be set to at least 32 characters`);
  return v ?? `dev-only-${name}`;
}

const JWT_SECRET = new TextEncoder().encode(secret("AUTH_SECRET"));
const SHARE_SECRET = secret("SHARE_SECRET");

export async function issueToken(userId: string): Promise<string> {
  return new jose.SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .setAudience("tandem")
    .setIssuer("tandem")
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET, {
      audience: "tandem",
      issuer: "tandem",
    });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}

export async function checkPassword(
  pw: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export function newUserId(): string {
  return randomBytes(8).toString("hex");
}

// Share tokens are `<base64url payload>.<HMAC-SHA256>`. The payload's actor id
// is the prefix for every guest on the link; the client's per-device suffix
// (see helloSchema.actor) keeps a reconnecting guest on the same actor, so its
// offline ops still converge, while two guests never share one.
export function issueShareToken(
  role: "editor" | "viewer",
  boardId: string,
  ttlSeconds: number,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const actorId = `guest-${role}-${randomBytes(6).toString("hex")}`;
  const payload = JSON.stringify({ v: 1, role, boardId, exp, actorId });
  const sig = createHmac("sha256", SHARE_SECRET)
    .update(payload)
    .digest("base64url");
  return Buffer.from(payload).toString("base64url") + "." + sig;
}

export function verifyShareToken(
  token: string,
  boardId: string,
): { role: "editor" | "viewer"; actorId: string } | null {
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expected = createHmac("sha256", SHARE_SECRET)
    .update(Buffer.from(payloadB64, "base64url").toString())
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(
    Buffer.from(payloadB64, "base64url").toString(),
  ) as {
    v: number;
    role: "editor" | "viewer";
    boardId: string;
    exp: number;
    actorId?: string;
  };
  if (payload.v !== 1 || payload.boardId !== boardId) return null;
  if (payload.exp < Date.now() / 1000) return null;
  if (
    payload.actorId === undefined ||
    !/^[a-z0-9-]{1,64}$/.test(payload.actorId)
  )
    return null;
  return { role: payload.role, actorId: payload.actorId };
}
