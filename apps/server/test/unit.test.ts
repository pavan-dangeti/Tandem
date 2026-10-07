import { describe, expect, it } from "vitest";
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
