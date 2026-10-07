import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as jose from "jose";
import bcrypt from "bcryptjs";

const JWT_SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? "dev-secret-change-in-production",
);
const SHARE_SECRET =
  process.env.SHARE_SECRET ??
  process.env.AUTH_SECRET ??
  "dev-secret-change-in-production";

// JWT used for user sessions. By direct design only a symmetric HMAC key is needed, and it's in env.
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

// Share tokens: HMAC-signed, tamper-proof, versioned strings: tandem://?tok=<payload>.<sig>
export function issueShareToken(
  role: "editor" | "viewer",
  boardId: string,
  ttlSeconds: number,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = JSON.stringify({ v: 1, role, boardId, exp });
  const sig = createHmac("sha256", SHARE_SECRET)
    .update(payload)
    .digest("base64url");
  return Buffer.from(payload).toString("base64url") + "." + sig;
}

export function verifyShareToken(
  token: string,
  boardId: string,
): { role: "editor" | "viewer" } | null {
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
  };
  if (payload.v !== 1 || payload.boardId !== boardId) return null;
  if (payload.exp < Date.now() / 1000) return null;
  return { role: payload.role };
}
