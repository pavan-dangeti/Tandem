import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { issueShareToken, verifyShareToken } from "../src/auth.js";

describe("share tokens", () => {
  it("round-trips", () => {
    const t = issueShareToken("editor", "b1", 3600);
    expect(verifyShareToken(t, "b1")?.role).toBe("editor");
  });

  it("rejects tampering", () => {
    const t = issueShareToken("viewer", "b1", 3600);
    expect(verifyShareToken(t.slice(0, -2) + "zz", "b1")).toBeNull();
  });

  it("rejects a token issued for another board", () => {
    const t = issueShareToken("editor", "b1", 3600);
    expect(verifyShareToken(t, "b2")).toBeNull();
  });

  it("rejects an expired token", () => {
    const t = issueShareToken("viewer", "b1", -1);
    expect(verifyShareToken(t, "b1")).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyShareToken("", "b1")).toBeNull();
    expect(verifyShareToken("nodot", "b1")).toBeNull();
  });
});

describe("production secrets", () => {
  it("refuses to start without AUTH_SECRET", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      PORT: "0",
    };
    delete env.AUTH_SECRET;
    delete env.SHARE_SECRET;
    const r = spawnSync("pnpm", ["exec", "tsx", "src/index.ts"], {
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("AUTH_SECRET");
  });
});
