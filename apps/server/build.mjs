import { build } from "esbuild";
import pkg from "./package.json" with { type: "json" };

// Workspace packages export their TypeScript sources, which plain node cannot
// load, so they are bundled in; npm dependencies stay external.
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  outfile: "dist/index.js",
  external: Object.keys(pkg.dependencies).filter(
    (d) => !d.startsWith("@tandem/"),
  ),
});
