import { describe, expect, it } from "vitest";
import { CRDT_VERSION } from "../src/index.js";

describe("crdt package", () => {
  it("exports a version", () => {
    expect(CRDT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
