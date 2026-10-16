import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { resultTables } from "./results.js";

// Fails when README figures drift from the committed results; regenerate the
// tables with `pnpm results` after rerunning a benchmark.
// Prettier pads table cells, so cells are compared without padding.
const unpad = (md: string): string =>
  md.replace(/ *\| */g, "|").replace(/-{3,}/g, "---");

describe("README results", () => {
  const readme = unpad(
    fs.readFileSync(new URL("../README.md", import.meta.url), "utf8"),
  );
  for (const [name, table] of Object.entries(resultTables()))
    it(`${name} table matches results/`, () => {
      expect(readme).toContain(unpad(table));
    });
});
